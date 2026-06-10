import * as cdk from 'aws-cdk-lib';
import * as cfninc from 'aws-cdk-lib/cloudformation-include';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface EdgeStackProps extends cdk.StackProps {
  readonly appName: string;
  readonly envName: string;
  readonly apiEndpoint: string;
}

export class EdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, _props: EdgeStackProps) {
    super(scope, id, _props);

    const included = new cfninc.CfnInclude(this, 'ImportedEdgeTemplate', {
      templateFile: path.join(__dirname, 'edge-template.json'),
      preserveLogicalIds: true,
    });

    const distribution = included.getResource('Distribution830FAC52') as cloudfront.CfnDistribution;
    distribution.addPropertyOverride('DistributionConfig.Origins.1.DomainName', {
      'Fn::Select': [
        2,
        {
          'Fn::Split': [
            '/',
            { 'Fn::ImportValue': 'launchtest-staging-api:ExportsOutputFnGetAttHttpApiF5A9A8A7ApiEndpoint082134F8' },
          ],
        },
      ],
    });
  }
}
