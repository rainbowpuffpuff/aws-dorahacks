import { mkdirSync, writeFileSync } from 'node:fs';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

type Check = { name: string; expected: string; actual: string; pass: boolean };

const region = 'us-east-1';
const account = process.env.AWS_ACCOUNT_ID ?? '109734929935';
const tableName = process.env.TABLE_NAME ?? 'launchtest-staging-data';
const gateRunnerRoleArn = `arn:aws:iam::${account}:role/launchtest-staging-gate-runner`;
const tenantRoleArn = `arn:aws:iam::${account}:role/launchtest-staging-tenant-data-access`;

const sts = new STSClient({ region });

function isAccessDenied(error: any) {
  const text = `${error?.name ?? ''} ${error?.Code ?? ''} ${error?.message ?? ''}`;
  return /AccessDenied|AccessDeniedException|not authorized|explicit deny|no identity-based policy/i.test(text);
}

async function assume(roleArn: string, sessionName: string, source?: any, tenantId?: string) {
  const client = source ? new STSClient({ region, credentials: source }) : sts;
  const result = await client.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    DurationSeconds: 900,
    Tags: tenantId ? [{ Key: 'tenant_id', Value: tenantId }] : undefined,
  }));
  const c = result.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error(`AssumeRole returned no credentials for ${roleArn}`);
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
}

function docClient(credentials: any) {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region, credentials }));
}

async function expectAccessDenied(checks: Check[], name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    checks.push({ name, expected: 'AccessDeniedException', actual: 'succeeded', pass: false });
  } catch (error: any) {
    checks.push({
      name,
      expected: 'AccessDeniedException',
      actual: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      pass: isAccessDenied(error),
    });
  }
}

async function main() {
  mkdirSync('gates', { recursive: true });
  const checks: Check[] = [];

  try {
    const gateRunner = await assume(gateRunnerRoleArn, 'gate-2-runner');
    const tenantA = await assume(tenantRoleArn, 'gate-2-tenant-a', gateRunner, 't-aaaa');
    const tenantAUntagged = await assume(tenantRoleArn, 'gate-2-untagged', gateRunner);
    const tenantADoc = docClient(tenantA);
    const untaggedDoc = docClient(tenantAUntagged);

    const item = {
      PK: 'TENANT#t-aaaa#ITEM',
      SK: 'ITEM#gate-2',
      GSI1PK: 'TENANT#t-aaaa#ITEM#BYSTATUS',
      GSI1SK: 'open#gate-2',
      tenantId: 't-aaaa',
      name: 'gate-2',
    };

    await tenantADoc.send(new PutCommand({ TableName: tableName, Item: item }));
    const ownRead = await tenantADoc.send(new GetCommand({
      TableName: tableName,
      Key: { PK: item.PK, SK: item.SK },
    }));
    checks.push({
      name: 'tenant t-aaaa write+read own item',
      expected: item.SK,
      actual: String(ownRead.Item?.SK ?? ''),
      pass: ownRead.Item?.SK === item.SK,
    });

    await expectAccessDenied(checks, 'tenant t-aaaa Query tenant t-bbbb table key denied', () => tenantADoc.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'TENANT#t-bbbb#ITEM' },
    })));

    await expectAccessDenied(checks, 'tenant t-aaaa Query tenant t-bbbb GSI key denied', () => tenantADoc.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'TENANT#t-bbbb#ITEM#BYSTATUS' },
    })));

    await expectAccessDenied(checks, 'tenant t-aaaa Scan denied', () => tenantADoc.send(new ScanCommand({
      TableName: tableName,
    }) as any));

    await expectAccessDenied(checks, 'untagged tenant role read denied', () => untaggedDoc.send(new GetCommand({
      TableName: tableName,
      Key: { PK: item.PK, SK: item.SK },
    })));
  } catch (error: any) {
    checks.push({
      name: 'gate execution',
      expected: 'no error',
      actual: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      pass: false,
    });
  }

  const result = {
    gate: 2,
    tableName,
    gateRunnerRoleArn,
    tenantRoleArn,
    checks,
    pass: checks.length === 5 && checks.every((check) => check.pass),
  };

  writeFileSync('gates/gate-2.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exit(1);
}

void main();
