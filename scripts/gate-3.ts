import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  AdminInitiateAuthCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

type Check = { name: string; expected: string; actual: string; pass: boolean };

const region = 'us-east-1';
const api = process.env.API_ENDPOINT ?? 'https://8l2td00s1c.execute-api.us-east-1.amazonaws.com';
const userPoolId = process.env.USER_POOL_ID ?? 'us-east-1_UXYlj0bTK';
const clientId = process.env.USER_POOL_CLIENT_ID ?? '5rmnipdmg5l8bpi4ufshe8pe78';
const email = process.env.ADMIN_EMAIL ?? 'acalincarol@gmail.com';
const password = process.env.GATE_PASSWORD ?? 'Launchtest-Temp-Password-123!';
const itemsLogGroup = '/aws/lambda/launchtest-staging-items';

const cognito = new CognitoIdentityProviderClient({ region });

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

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : undefined; } catch {}
  return { status: response.status, body, text };
}

function add(checks: Check[], name: string, expected: string, actual: string, pass: boolean) {
  checks.push({ name, expected, actual, pass });
}

async function main() {
  mkdirSync('gates', { recursive: true });
  const checks: Check[] = [];
  let itemId = '';

  try {
    const startMs = Date.now() - 60_000;
    const noToken = await request('/v1/items', { method: 'POST', body: JSON.stringify({ name: 'gate3-no-token' }) });
    add(checks, 'no-token POST /v1/items', '401', String(noToken.status), noToken.status === 401);

    const accessToken = await token();
    const authHeaders = { authorization: `Bearer ${accessToken}` };

    const created = await request('/v1/items', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: `gate3-${Date.now()}`, status: 'active' }),
    });
    itemId = created.body?.id ?? '';
    add(checks, 'with token POST /v1/items', '201 with id', `${created.status} ${itemId}`, created.status === 201 && !!itemId);

    const listed = await request('/v1/items?status=active', { headers: authHeaders });
    add(checks, 'GET /v1/items contains created item', '200 containing id', `${listed.status} contains=${JSON.stringify(listed.body).includes(itemId)}`, listed.status === 200 && JSON.stringify(listed.body).includes(itemId));

    const me = await request('/v1/me', { headers: authHeaders });
    const meFields = ['sub', 'email', 'tenant_id', 'groups'].filter((field) => me.body?.[field] !== undefined && me.body?.[field] !== null);
    add(checks, 'GET /v1/me has all fields', 'sub,email,tenant_id,groups', `${me.status} ${meFields.join(',')}`, me.status === 200 && meFields.length === 4);

    const stale = await request(`/v1/items/${itemId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ version: 0, status: 'closed' }),
    });
    add(checks, 'PUT stale version', '409', String(stale.status), stale.status === 409);

    const originalName = created.body?.name;
    const updated = await request(`/v1/items/${itemId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ version: created.body?.version, status: 'paused' }),
    });
    const readBack = await request(`/v1/items/${itemId}`, { headers: authHeaders });
    add(checks, 'PUT omitting name preserves name', originalName, String(readBack.body?.name ?? updated.body?.name ?? ''), updated.status === 200 && readBack.body?.name === originalName);

    const healthz = await request('/v1/healthz');
    add(checks, 'healthz tokenless', '200', String(healthz.status), healthz.status === 200);

    let loopOk = 0;
    for (let i = 0; i < 25; i += 1) {
      const r = await request('/v1/healthz');
      if (r.status >= 200 && r.status < 300) loopOk += 1;
    }
    add(checks, '25-request loop all 2xx', '25', String(loopOk), loopOk === 25);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    let logActual = 'no matching log';
    try {
      const out = execFileSync('aws', [
        'logs', 'filter-log-events',
        '--log-group-name', itemsLogGroup,
        '--start-time', String(startMs),
        '--filter-pattern', 'tenantId latencyMs requestId',
        '--max-items', '25',
        '--query', 'events[].message',
        '--output', 'json',
      ], { encoding: 'utf8' });
      const messages = JSON.parse(out);
      const structured = messages.find((message: string) => {
        const jsonStart = message.indexOf('{');
        if (jsonStart < 0) return false;
        try {
          const parsed = JSON.parse(message.slice(jsonStart));
          return parsed.requestId && parsed.tenantId && typeof parsed.status === 'number' && typeof parsed.latencyMs === 'number';
        } catch {
          return false;
        }
      });
      logActual = structured ?? 'no matching log';
      add(checks, 'items log structured R10 line', 'at least one matching event', logActual, !!structured);
    } catch (error: any) {
      add(checks, 'items log structured R10 line', 'at least one matching event', `${error?.message ?? error}`, false);
    }
  } catch (error: any) {
    add(checks, 'gate execution', 'no error', `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`, false);
  }

  const result = { gate: 3, api, itemId, checks, pass: checks.length === 9 && checks.every((check) => check.pass) };
  writeFileSync('gates/gate-3.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exit(1);
}

void main();
