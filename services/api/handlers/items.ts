import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { monotonicFactory } from 'ulid';

const tableName = process.env.TABLE_NAME!;
const tenantRoleArn = process.env.TENANT_ROLE_ARN!;
const appName = process.env.APP_NAME ?? 'launchtest';
const eventBusName = process.env.EVENT_BUS_NAME!;

const sts = new STSClient({});
const events = new EventBridgeClient({});
const ulid = monotonicFactory();
const cache = new Map<string, { expiresAt: number; doc: DynamoDBDocumentClient }>();

function json(body: unknown, statusCode = 200): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function error(code: string, message: string, statusCode: number, requestId: string) {
  return json({ error: { code, message, requestId } }, statusCode);
}

function tenantPrefix(tenantId: string) {
  return `TENANT#${tenantId}`;
}

function claims(event: any) {
  const c = event.requestContext?.authorizer?.jwt?.claims ?? {};
  if (!c.tenant_id) throw Object.assign(new Error('tenant_id missing from token'), { statusCode: 401 });
  let groups: string[] = [];
  const rawGroups = c['cognito:groups'];
  if (Array.isArray(rawGroups)) groups = rawGroups;
  else if (typeof rawGroups === 'string') {
    try {
      const parsed = JSON.parse(rawGroups);
      groups = Array.isArray(parsed) ? parsed : [rawGroups];
    } catch {
      groups = [rawGroups];
    }
  }
  return { sub: c.sub, email: c.email, tenant_id: c.tenant_id, 'cognito:groups': groups };
}

async function tenantDoc(tenantId: string) {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > now) return hit.doc;
  const assumed = await sts.send(new AssumeRoleCommand({
    RoleArn: tenantRoleArn,
    RoleSessionName: `tenant-${tenantId}`,
    Tags: [{ Key: 'tenant_id', Value: tenantId }],
    DurationSeconds: 900,
  }));
  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    throw new Error('AssumeRole returned incomplete credentials');
  }
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    },
  }), { marshallOptions: { removeUndefinedValues: true } });
  if (cache.size >= 100) cache.delete([...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0][0]);
  cache.set(tenantId, { doc, expiresAt: c.Expiration.getTime() - 60_000 });
  return doc;
}

export async function handler(event: any): Promise<APIGatewayProxyStructuredResultV2> {
  const started = Date.now();
  const requestId = event.requestContext?.requestId ?? 'unknown';
  const route = `${event.requestContext?.http?.method ?? ''} ${event.rawPath ?? ''}`.trim();
  let tenantId = 'unknown';
  let status = 500;

  try {
    const identity = claims(event);
    tenantId = identity.tenant_id;
    const doc = await tenantDoc(tenantId);
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const itemPk = `${tenantPrefix(tenantId)}#ITEM`;

    let response: APIGatewayProxyStructuredResultV2;

    if (method === 'POST' && path === '/v1/tenants') {
      response = (identity['cognito:groups'] ?? []).includes('platform-admins')
        ? json({ message: 'Tenant provisioning not implemented in handler - use scripts/create-tenant.ts' })
        : error('FORBIDDEN', 'platform-admins group required', 403, requestId);
      status = response.statusCode ?? 200;
      return response;
    }

    if (method === 'POST' && path === '/v1/items') {
      let body: any;
      try { body = JSON.parse(event.body ?? '{}'); } catch { response = error('VALIDATION', 'Invalid JSON body', 400, requestId); status = 400; return response; }
      if (!body.name || typeof body.name !== 'string') {
        response = error('VALIDATION', 'name (string) required', 400, requestId);
        status = 400;
        return response;
      }
      const id = ulid();
      const now = Date.now();
      const item = {
        PK: itemPk,
        SK: `ITEM#${id}`,
        GSI1PK: `${tenantPrefix(tenantId)}#ITEM#BYSTATUS`,
        GSI1SK: `${body.status ?? 'active'}#${id}`,
        id,
        tenantId,
        name: body.name,
        status: body.status ?? 'active',
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await doc.send(new PutCommand({ TableName: tableName, Item: item }));
      await events.send(new PutEventsCommand({
        Entries: [{ EventBusName: eventBusName, Source: `${appName}.items`, DetailType: 'ItemCreated', Detail: JSON.stringify({ tenantId, itemId: id, at: now }) }],
      }));
      console.log(JSON.stringify({
        _aws: { Timestamp: now, CloudWatchMetrics: [{ Namespace: appName, Dimensions: [['service']], Metrics: [{ Name: 'ItemCreated', Unit: 'Count' }] }] },
        service: 'items',
        ItemCreated: 1,
      }));
      response = json(item, 201);
      status = 201;
      return response;
    }

    if (method === 'GET' && !event.pathParameters?.id) {
      const query = await doc.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `${tenantPrefix(tenantId)}#ITEM#BYSTATUS`,
          ':sk': `${event.queryStringParameters?.status ?? 'active'}#`,
        },
        Limit: 50,
        ExclusiveStartKey: event.queryStringParameters?.nextToken
          ? JSON.parse(Buffer.from(event.queryStringParameters.nextToken, 'base64url').toString())
          : undefined,
      }));
      response = json({
        items: query.Items ?? [],
        nextToken: query.LastEvaluatedKey ? Buffer.from(JSON.stringify(query.LastEvaluatedKey)).toString('base64url') : undefined,
      });
      status = 200;
      return response;
    }

    const id = event.pathParameters?.id;
    if (!id) {
      response = error('NOT_FOUND', 'Item id required', 404, requestId);
      status = 404;
      return response;
    }

    if (method === 'GET') {
      const item = await doc.send(new GetCommand({ TableName: tableName, Key: { PK: itemPk, SK: `ITEM#${id}` } }));
      response = item.Item ? json(item.Item) : error('NOT_FOUND', 'Item not found', 404, requestId);
      status = response.statusCode ?? 200;
      return response;
    }

    if (method === 'PUT') {
      let body: any;
      try { body = JSON.parse(event.body ?? '{}'); } catch { response = error('VALIDATION', 'Invalid JSON body', 400, requestId); status = 400; return response; }
      if (typeof body.version !== 'number') {
        response = error('VALIDATION', 'version (number) required', 400, requestId);
        status = 400;
        return response;
      }

      const names: Record<string, string> = {};
      const values: Record<string, unknown> = { ':ver': body.version, ':newVer': body.version + 1, ':now': Date.now() };
      const sets = ['version = :newVer', 'updatedAt = :now'];
      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        if (typeof body.name !== 'string' || !body.name) {
          response = error('VALIDATION', 'name must be a non-empty string when provided', 400, requestId);
          status = 400;
          return response;
        }
        names['#n'] = 'name';
        values[':name'] = body.name;
        sets.push('#n = :name');
      }
      if (Object.prototype.hasOwnProperty.call(body, 'status')) {
        if (typeof body.status !== 'string' || !body.status) {
          response = error('VALIDATION', 'status must be a non-empty string when provided', 400, requestId);
          status = 400;
          return response;
        }
        names['#s'] = 'status';
        values[':status'] = body.status;
        values[':gsi1sk'] = `${body.status}#${id}`;
        sets.push('#s = :status', 'GSI1SK = :gsi1sk');
      }
      try {
        const updated = await doc.send(new UpdateCommand({
          TableName: tableName,
          Key: { PK: itemPk, SK: `ITEM#${id}` },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'version = :ver',
          ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }));
        response = json(updated.Attributes);
        status = 200;
        return response;
      } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
          response = error('CONFLICT', 'Version mismatch', 409, requestId);
          status = 409;
          return response;
        }
        throw err;
      }
    }

    if (method === 'DELETE') {
      await doc.send(new DeleteCommand({ TableName: tableName, Key: { PK: itemPk, SK: `ITEM#${id}` } }));
      status = 204;
      return { statusCode: 204 };
    }

    response = error('NOT_FOUND', 'Route not found', 404, requestId);
    status = 404;
    return response;
  } catch (err: any) {
    console.error(JSON.stringify({ requestId, route, tenantId, error: err.message, stack: err.stack }));
    const response = error('INTERNAL', 'Internal server error', 500, requestId);
    status = 500;
    return response;
  } finally {
    console.log(JSON.stringify({ requestId, route, tenantId, status, latencyMs: Date.now() - started }));
  }
}
