import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  AdminInitiateAuthCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

type Check = { name: string; expected: string; actual: string; pass: boolean };

const region = 'us-east-1';
const api = 'https://8l2td00s1c.execute-api.us-east-1.amazonaws.com';
const userPoolId = 'us-east-1_UXYlj0bTK';
const clientId = '5rmnipdmg5l8bpi4ufshe8pe78';
const email = process.env.ADMIN_EMAIL ?? 'acalincarol@gmail.com';
const password = process.env.GATE_PASSWORD ?? 'Launchtest-Temp-Password-123!';
const busName = 'launchtest-staging-bus';
const dlqUrl = 'https://sqs.us-east-1.amazonaws.com/109734929935/launchtest-staging-events-dlq';
const consumerLogGroup = '/aws/lambda/launchtest-staging-consumer';

const cognito = new CognitoIdentityProviderClient({ region });
const events = new EventBridgeClient({ region });
const sqs = new SQSClient({ region });

function add(checks: Check[], name: string, expected: string, actual: string, pass: boolean) {
  checks.push({ name, expected, actual, pass });
}

async function token() {
  const auth = await cognito.send(new AdminInitiateAuthCommand({
    UserPoolId: userPoolId,
    ClientId: clientId,
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const accessToken = auth.AuthenticationResult?.AccessToken;
  if (!accessToken) throw new Error('no access token');
  return accessToken;
}

async function createItem() {
  const accessToken = await token();
  const response = await fetch(`${api}/v1/items`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `gate4-${Date.now()}`, status: 'active' }),
  });
  const body = await response.json() as any;
  if (response.status !== 201 || !body.id) throw new Error(`create item failed: ${response.status} ${JSON.stringify(body)}`);
  return body.id as string;
}

function recentConsumerMessages(startMs: number) {
  const out = execFileSync('aws', [
    'logs', 'filter-log-events',
    '--log-group-name', consumerLogGroup,
    '--start-time', String(startMs),
    '--filter-pattern', 'audit written',
    '--max-items', '50',
    '--query', 'events[].message',
    '--output', 'json',
  ], { encoding: 'utf8' });
  return JSON.parse(out) as string[];
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  mkdirSync('gates', { recursive: true });
  const checks: Check[] = [];
  let itemId = '';

  try {
    const startMs = Date.now() - 30_000;
    itemId = await createItem();

    let auditActual = 'not found';
    for (let i = 0; i < 24; i += 1) {
      const messages = recentConsumerMessages(startMs);
      const match = messages.find((message) => message.includes(itemId) && message.includes('audit written'));
      if (match) {
        auditActual = match;
        break;
      }
      await sleep(5000);
    }
    add(checks, 'ItemCreated event writes audit item', `consumer log contains audit written for ${itemId}`, auditActual, auditActual !== 'not found');

    await events.send(new PutEventsCommand({
      Entries: [{
        EventBusName: busName,
        Source: 'launchtest.items',
        DetailType: 'ItemCreated',
        Detail: JSON.stringify({ malformed: true, at: Date.now() }),
      }],
    }));

    let visible = '0';
    const dlqPolls: string[] = [];
    for (let i = 0; i < 31; i += 1) {
      const attrs = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      visible = attrs.Attributes?.ApproximateNumberOfMessages ?? '0';
      dlqPolls.push(`${new Date().toISOString()}=${visible}`);
      if (Number(visible) >= 1) break;
      await sleep(30_000);
    }
    add(checks, 'malformed event reaches DLQ', 'ApproximateNumberOfMessages >= 1', `${visible}; polls: ${dlqPolls.join(', ')}`, Number(visible) >= 1);
  } catch (error: any) {
    add(checks, 'gate execution', 'no error', `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`, false);
  }

  const result = { gate: 4, itemId, checks, pass: checks.length === 2 && checks.every((check) => check.pass) };
  writeFileSync('gates/gate-4.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exit(1);
}

void main();
