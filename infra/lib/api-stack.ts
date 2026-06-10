import * as cdk from 'aws-cdk-lib';
import * as cfninc from 'aws-cdk-lib/cloudformation-include';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Construct } from 'constructs';

export interface ApiStackProps extends cdk.StackProps {
  readonly appName: string;
  readonly envName: string;
  readonly monthlyBudgetUsd: number;
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
}

export class ApiStack extends cdk.Stack {
  public readonly apiEndpoint: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const included = new cfninc.CfnInclude(this, 'ImportedApiTemplate', {
      templateFile: path.join(__dirname, 'api-template.json'),
      preserveLogicalIds: true,
    });

    const itemsFn = included.getResource('items07D08F4B') as lambda.CfnFunction;
    const itemsCode = lambda.Code.fromAsset(path.join(__dirname, '../../services/api/handlers'), {
      bundling: {
        image: cdk.DockerImage.fromRegistry('public.ecr.aws/sam/build-nodejs22.x'),
        local: {
          tryBundle(outputDir: string) {
            execFileSync('npx', [
              'esbuild',
              path.join(__dirname, '../../services/api/handlers/items.ts'),
              '--bundle',
              '--platform=node',
              '--target=node22',
              '--outfile=' + path.join(outputDir, 'index.js'),
            ], { stdio: 'inherit' });
            return fs.existsSync(path.join(outputDir, 'index.js'));
          },
        },
      },
    });
    const bound = itemsCode.bind(this);
    itemsCode.bindToResource(itemsFn);
    if (!bound.s3Location) throw new Error('items Lambda code asset did not produce an S3 location');
    itemsFn.addPropertyOverride('Code', {
      S3Bucket: bound.s3Location.bucketName,
      S3Key: bound.s3Location.objectKey,
    });

    this.apiEndpoint = `https://8l2td00s1c.execute-api.${this.region}.amazonaws.com`;
  }
}
