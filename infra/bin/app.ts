import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { CoreStack } from '../lib/core-stack';
import { EdgeStack } from '../lib/edge-stack';

const app = new cdk.App();

const appName = app.node.tryGetContext('appName') as string;
const envName = app.node.tryGetContext('envName') as string;
const awsRegion = app.node.tryGetContext('awsRegion') as string;
const alertEmail = app.node.tryGetContext('alertEmail') as string;
const monthlyBudgetUsd = app.node.tryGetContext('monthlyBudgetUsd') as string;

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: awsRegion,
};

cdk.Tags.of(app).add('project', appName);
cdk.Tags.of(app).add('env', envName);
cdk.Tags.of(app).add('managed-by', 'cdk');
cdk.Tags.of(app).add('owner', alertEmail);

const core = new CoreStack(app, `${appName}-${envName}-core`, {
  env,
  appName,
  envName,
  crossRegionReferences: true,
});

const api = new ApiStack(app, `${appName}-${envName}-api`, {
  env,
  appName,
  envName,
  monthlyBudgetUsd: Number(monthlyBudgetUsd),
  crossRegionReferences: true,
  userPool: core.userPool,
  userPoolClient: core.userPoolClient,
});

new EdgeStack(app, `${appName}-${envName}-edge`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  appName,
  envName,
  crossRegionReferences: true,
  apiEndpoint: api.apiEndpoint,
});
