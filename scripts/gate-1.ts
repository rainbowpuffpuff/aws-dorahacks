import { mkdirSync, writeFileSync } from 'node:fs';
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

type Check = { name: string; expected: string; actual: string; pass: boolean };

const region = 'us-east-1';
const userPoolId = process.env.USER_POOL_ID ?? 'us-east-1_UXYlj0bTK';
const clientId = process.env.USER_POOL_CLIENT_ID ?? '5rmnipdmg5l8bpi4ufshe8pe78';
const email = process.env.ADMIN_EMAIL ?? 'acalincarol@gmail.com';
const tenantId = process.env.GATE_TENANT_ID ?? 't-a1b2c3d4';
const password = process.env.GATE_PASSWORD ?? 'Launchtest-Temp-Password-123!';

const cognito = new CognitoIdentityProviderClient({ region });

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  if (!payload) throw new Error('access token is not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function ensureUser() {
  try {
    await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  } catch (error: any) {
    if (error?.name !== 'UserNotFoundException') throw error;
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:tenant_id', Value: tenantId },
      ],
    }));
  }

  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username: email,
    Password: password,
    Permanent: true,
  }));
}

async function main() {
  mkdirSync('gates', { recursive: true });
  const checks: Check[] = [];
  let claims: Record<string, unknown> = {};

  try {
    await ensureUser();
    const auth = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    }));

    const accessToken = auth.AuthenticationResult?.AccessToken;
    if (!accessToken) throw new Error('AdminInitiateAuth returned no access token');
    claims = decodeJwtPayload(accessToken);

    checks.push({
      name: 'tenant_id present',
      expected: 'non-empty',
      actual: String(claims.tenant_id ?? ''),
      pass: typeof claims.tenant_id === 'string' && claims.tenant_id.length > 0,
    });
    checks.push({
      name: 'email present',
      expected: email,
      actual: String(claims.email ?? ''),
      pass: claims.email === email,
    });
    checks.push({
      name: 'token_use',
      expected: 'access',
      actual: String(claims.token_use ?? ''),
      pass: claims.token_use === 'access',
    });
  } catch (error: any) {
    checks.push({
      name: 'gate execution',
      expected: 'no error',
      actual: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      pass: false,
    });
  }

  const result = {
    gate: 1,
    userPoolId,
    clientId,
    claims,
    checks,
    pass: checks.length > 0 && checks.every((check) => check.pass),
  };
  writeFileSync('gates/gate-1.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exit(1);
}

void main();
