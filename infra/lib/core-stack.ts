import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface CoreStackProps extends cdk.StackProps {
  readonly appName: string;
  readonly envName: string;
}

export class CoreStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly dataTable: dynamodb.Table;
  public readonly tenantDataAccessRole: iam.Role;

  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);

    const appName = props.appName;
    const envName = props.envName;
    const isProd = envName === 'prod';

    const preTokenLogGroup = new logs.LogGroup(this, 'PreTokenLogGroup', {
      logGroupName: `/aws/lambda/${appName}-${envName}-pre-token`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const preTokenFn = new nodejs.NodejsFunction(this, 'PreTokenFn', {
      functionName: `${appName}-${envName}-pre-token`,
      entry: path.join(__dirname, '../../services/api/pre-token.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: preTokenLogGroup,
      environment: {
        POWERTOOLS_SERVICE_NAME: `${appName}-pre-token`,
        POWERTOOLS_METRICS_NAMESPACE: appName,
      },
      bundling: {
        target: 'node22',
      },
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${appName}-${envName}-users`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      customAttributes: {
        tenant_id: new cognito.StringAttribute({ minLen: 1, maxLen: 36, mutable: false }),
      },
      deletionProtection: isProd,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      preTokenFn,
      cognito.LambdaVersion.V2_0,
    );

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${appName}-web`,
      generateSecret: false,
      authFlows: {
        userSrp: true,
        adminUserPassword: true,
      },
      accessTokenValidity: cdk.Duration.minutes(60),
      idTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.PHONE,
          cognito.OAuthScope.COGNITO_ADMIN,
        ],
        callbackUrls: ['https://example.com'],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      groupName: 'platform-admins',
      description: 'Cross-tenant platform operators',
      userPoolId: this.userPool.userPoolId,
    });

    this.dataTable = new dynamodb.Table(this, 'DataTable', {
      tableName: `${appName}-${envName}-data`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      deletionProtection: isProd,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.dataTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const assumers = ['api-lambda', 'consumer', 'gate-runner']
      .map((name) => `arn:aws:iam::${this.account}:role/${appName}-${envName}-${name}`);
    const trustCond = { ArnEquals: { 'aws:PrincipalArn': assumers } };
    this.tenantDataAccessRole = new iam.Role(this, 'TenantDataAccessRole', {
      roleName: `${appName}-${envName}-tenant-data-access`,
      assumedBy: new iam.AccountPrincipal(this.account).withConditions(trustCond),
    });
    (this.tenantDataAccessRole.assumeRolePolicy as iam.PolicyDocument).addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.AccountPrincipal(this.account)],
        conditions: trustCond,
      }),
    );

    this.tenantDataAccessRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:BatchGetItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:ConditionCheckItem',
      ],
      resources: [
        this.dataTable.tableArn,
        `${this.dataTable.tableArn}/index/*`,
      ],
      conditions: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': ['TENANT#${aws:PrincipalTag/tenant_id}#*'],
        },
      },
    }));

    const gateRunner = new iam.Role(this, 'GateRunnerRole', {
      roleName: `${appName}-${envName}-gate-runner`,
      assumedBy: new iam.AccountRootPrincipal(),
    });
    gateRunner.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [this.tenantDataAccessRole.roleArn],
    }));

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `${appName}-${envName}-UserPoolId`,
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${appName}-${envName}-UserPoolClientId`,
    });
    new cdk.CfnOutput(this, 'TableName', {
      value: this.dataTable.tableName,
      exportName: `${appName}-${envName}-TableName`,
    });
    new cdk.CfnOutput(this, 'TenantDataAccessRoleArn', {
      value: this.tenantDataAccessRole.roleArn,
      exportName: `${appName}-${envName}-TenantDataAccessRoleArn`,
    });
    new cdk.CfnOutput(this, 'ExportsOutputRefUserPoolWebClient4C9370B02E2C9FF9', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${appName}-${envName}-core:ExportsOutputRefUserPoolWebClient4C9370B02E2C9FF9`,
    });
    new cdk.CfnOutput(this, 'ExportsOutputRefDataTable447BC44E7F3657BE', {
      value: this.dataTable.tableName,
      exportName: `${appName}-${envName}-core:ExportsOutputRefDataTable447BC44E7F3657BE`,
    });
    new cdk.CfnOutput(this, 'ExportsOutputRefUserPool6BA7E5F296FD7236', {
      value: this.userPool.userPoolId,
      exportName: `${appName}-${envName}-core:ExportsOutputRefUserPool6BA7E5F296FD7236`,
    });
    new cdk.CfnOutput(this, 'ExportsOutputFnGetAttTenantDataAccessRoleE89F5ABCArn3376BAC7', {
      value: this.tenantDataAccessRole.roleArn,
      exportName: `${appName}-${envName}-core:ExportsOutputFnGetAttTenantDataAccessRoleE89F5ABCArn3376BAC7`,
    });
  }
}
