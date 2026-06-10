# Multi-Tenant-SaaS-Launchpad v2 — IAM-Enforced Tenant Isolation on AWS, Gate-Verified

> A copy-paste prompt for Kiro CLI (or Claude Code / Cursor) that takes an **empty AWS account to a deployed multi-tenant serverless SaaS foundation** — Cognito tenancy, DynamoDB with **IAM-enforced tenant isolation** (STS session tags + `dynamodb:LeadingKeys`), HTTP API, EventBridge/SQS async backbone, CloudFront + WAF edge — and **proves every layer with 9 machine-checkable validation gates** that write `gates/gate-N.json`, including negative tests: cross-tenant Query, cross-tenant GSI query, Scan, and untagged role assumption must ALL be denied at the IAM layer.

---

## 1. Prompt Title
**Multi-Tenant-SaaS-Launchpad v2: Production Serverless Foundation on AWS (Cognito + DynamoDB + HTTP API + EventBridge + CloudFront/WAF) with Tenant Isolation Enforced by IAM and Proven by Negative-Test Gates**

## 2. Description & Use Case
Most "multi-tenant SaaS starter" templates enforce tenancy in application code only — one missed `WHERE tenant_id =` and tenant A reads tenant B. This prompt builds the version where **IAM is the backstop**: every data-plane call runs on STS credentials tagged with the caller's `tenant_id` (taken ONLY from the verified JWT, injected by a fail-closed Cognito pre-token trigger), and the DynamoDB policy's `LeadingKeys` condition makes cross-tenant access *physically deniable* — including on GSIs, including Scan (no Scan permission exists at all).

It doesn't claim isolation — it **proves** it. Gate 2, "the money gate," is a script that assumes the tenant role tagged as tenant-A and demonstrates AccessDeniedException on tenant-B's partition, on the GSI, on Scan, and on an untagged assumption, writing the evidence to `gates/gate-2.json`. Eight more gates verify identity, API behavior, async delivery + DLQ poisoning, edge serving, alarms, and budget the same way.

**v2 is also battle-hardened for the agent itself.** A prior run with a low-capability coding model derailed on a dependency cycle, hallucinated package versions, guessed-wrong CDK props, and a broken IAM trust "fix" that silently destroyed the isolation guarantee. v2 converts every one of those failures into an operating rule, a verbatim snippet, or a gate assertion — the weak model's failure modes are designed out, not hoped away.

**Field-tested end-to-end.** A full run on a clean AWS account (June 10, 2026) deployed all three stacks, and the gates caught **five real defects live** — a missing token claim, a field-clobbering PUT, a missing log-contract line, a role-name contract violation, and an edge origin misconfiguration. Each was fixed and re-proven green — including recovering a `ROLLBACK_COMPLETE` CloudFront stack via the failure playbook — with zero human debugging. The gate evidence is committed in the repo under `gates/`.

**Who it's for:** any team turning "we should build this as multi-tenant SaaS" into something a security reviewer can sign off — B2B SaaS foundations, internal multi-team platforms, client portals, vertical SaaS with compliance-sensitive tenant separation.

## 3. Category
**Code Development** (the prompt generates production-ready Infrastructure-as-Code + a gate-verification harness).

## 4. AWS Services Used
- **Amazon Cognito** — user pool with feature plan ESSENTIALS, immutable `custom:tenant_id`, **Pre-Token-Generation V2 trigger** injecting `tenant_id` + `email` into the ACCESS token, fail-closed (no tenant → no token).
- **AWS IAM + STS** — the isolation core: `AssumeRole` with session tag `tenant_id`; trust = account principal constrained by `aws:PrincipalArn` condition (string-matched, no existence check → no deploy-ordering trap); `sts:TagSession` explicitly allowed; **no Scan permission anywhere**.
- **Amazon DynamoDB** — single table + GSI1, every PK/GSI1PK prefixed `TENANT#<tenant_id>#`, scoped by `dynamodb:LeadingKeys` with `${aws:PrincipalTag/tenant_id}`; on-demand, PITR, TTL.
- **Amazon API Gateway (HTTP API)** — Cognito JWT authorizer, throttling, JSON access logs.
- **AWS Lambda** — arm64 / Node.js 22, one execution role per concern (api, public, tenants-control, consumer), structured JSON log contract per invocation.
- **Amazon EventBridge → Amazon SQS** — custom bus, ItemCreated rule, queue with DLQ (maxReceive 3), consumer with partial-batch failures.
- **Amazon CloudFront + AWS WAF** — private S3 site via OAC, `/v1/*` API behavior, 3 managed rule groups + rate limit, SPA fallback via **CloudFront Function URI rewrite** (so API 403/404s are never rewritten to 200 HTML).
- **Amazon S3, Amazon CloudWatch (dashboard + 7 alarms), Amazon SNS, AWS Budgets, AWS X-Ray**; optional **GitHub OIDC** keyless CI/CD.

## 5. The Complete Prompt (copy-paste ready)

> Paste everything in the block below into **Kiro CLI** (recommended) or Claude Code / Cursor, from an empty directory. The agent will ask for your parameter values, then build phase by phase, stopping at each of the 9 gates with a `gates/gate-N.json` evidence file. See the runbook for exactly what to answer and what each gate should show.

````text
# MULTI-TENANT SAAS LAUNCHPAD v2 — PRODUCTION SERVERLESS FOUNDATION ON AWS

You are a senior AWS platform engineer acting as my hands-on build partner. Take me
from an empty AWS account to a deployed, production-ready, multi-tenant serverless
SaaS foundation — with tenant isolation enforced by IAM, not just application code.

PARAMETERS — ask for any value not filled in before you start:
- APP_NAME: <kebab-case>            ENV: <staging|prod> (default staging)
- AWS_REGION: <default us-east-1>   (edge stack is always pinned to us-east-1)
- ALERT_EMAIL / ADMIN_EMAIL / MONTHLY_BUDGET_USD (default 100)
- GITHUB_REPO: <org/repo or "skip">

PARAMETER HYGIENE: echo every received value back in a table before building.
Terminal paste pipelines mangle emails and pkg@version strings into
"[email protected]" placeholders — if any value looks redacted, mangled, or is
still a <template>, ask for it again instead of building with it.

## OPERATING RULES (each rule exists because a prior run violated it and derailed)

R0. **WORKSPACE GUARD — before parameters, before anything.** Verify the working
    directory: `pwd` must be a fresh, writable project directory in the user's
    home (create ~/<APP_NAME> if needed); prove writability with
    `touch .write-test && rm .write-test`. If the session is anchored in a system
    path (/usr/*, /bin, /etc, /opt) or any non-writable dir: do NOT escalate
    privileges command-by-command and do NOT exile the repo to /tmp (a reboot
    deletes it). Create ~/<APP_NAME>, then STOP and tell the user to restart
    their agent CLI from that directory — agent CLIs anchor their sandbox
    metadata to the directory they were STARTED in, so `cd` alone does not fix
    the permission errors. (Prior run started in /usr/bin: every command needed
    a manual approval, the file-edit tool was broken the entire session, and the
    repo landed in /tmp.)
    If every shell command still triggers a per-command approval prompt, pause
    and ask the user to enable the CLI's trusted/auto-approve mode for shell and
    file edits — a 9-gate build is hundreds of commands.
    **BUILD HOST CONFIRMATION (part of R0):** this machine is the ONE build
    host — every AWS CLI call, deploy, gate script, and teardown in this build
    runs HERE, on the credentials visible HERE. Run
    `aws sts get-caller-identity` and echo the ARN back with: "All 9 phases
    will run on this machine as <ARN> — confirm, or restart me on the machine
    that should own the build." If the user describes running steps on a
    different machine mid-build (their laptop, another box), warn that mixed
    identities mask permission gaps — a command that succeeds on their laptop's
    admin user proves nothing about this host's role — and that anything they
    run elsewhere is outside the gates' evidence. The ONLY user-side actions off
    this host: clicking confirmation emails, viewing URLs in a browser.

R1. **IaC only.** AWS CDK v2 (TypeScript), Node.js 22, NodejsFunction/esbuild
    bundling. No console-created resources.
R2. **One package.json, at the repo root.** No workspaces, no nested package.json
    files. cdk.json lives at the root with `"app": "npx ts-node --prefer-ts-exts
    infra/bin/app.ts"`. Handlers under services/ are bundled fine because the
    project root IS the package root. (Prior run created infra/package.json, then a
    root workspace mid-build, duplicated every dependency into two node_modules
    trees, and lost ~10 tool calls to esbuild/ulid resolution errors.)
R3. **Never hand-type a version number.** Install everything with
    `npm install <pkg>@latest` (or no tag) and let the registry resolve. You do not
    know current versions; every guessed pin in the prior run (vitest 2.2.5,
    aws-cdk 2.1008.0, esbuild 0.25.5) failed install. After install, READ
    package.json to learn what you got.
R4. **Verify before you write CDK code against a prop you are not certain exists.**
    Before using any construct prop/enum you haven't used in this session, grep the
    installed types first:
    `grep -rn "<propName>" node_modules/aws-cdk-lib/<module>/lib/*.d.ts | head`.
    Synth-failure-driven discovery wastes a full edit-synth cycle per guess. (Prior
    run guessed wrong on: mfaSecondFactor `totp` (it's `otp`), Cognito trigger
    wiring (it's `userPool.addTrigger(UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
    fn, LambdaVersion.V2_0)` — not a lambdaTriggers prop), HTTP API
    accessLogSettings shape, and passed a `https://` URL to HttpOrigin which
    requires a bare domain.)
R5. **Deploy one named stack per phase. Never `cdk deploy --all`.** The phase tells
    you which stack. Stop at every VALIDATION GATE, run the gate script, show real
    output. Never skip a gate; never deploy the next stack before the current gate
    is green.
R6. **Gates are scripts, not prose.** Every gate is
    `npx ts-node scripts/gate-N.ts` (or bash) that performs its checks
    programmatically and writes `gates/gate-N.json`:
    `{"gate": N, "checks": [{"name", "expected", "actual", "pass"}], "pass": bool}`.
    Paste the JSON. A gate passes only if every check passes. Claims without a
    result file don't count. Write gate scripts strict-mode-safe: type parsed
    JSON/HTTP bodies as `any` (or cast) — a live run lost a cycle to a TS
    'unknown' compile error inside a gate script.
R7. **On any failure: read section FAILURE PLAYBOOK first**, state the matching row
    (or say no row matches), explain root cause in one paragraph, then fix. Do not
    enter an edit-retry loop without naming a diagnosis. Max 2 fix attempts per
    distinct error, then stop and present options.
R8. Least privilege everywhere. No IAM users, no access keys, no wildcard resources
    in data-plane policies, no AdministratorAccess. One execution role per Lambda
    concern (api-items, api-public, tenants-control, consumer) — fixed, predictable
    role names: `<APP>-<ENV>-api-lambda`, `<APP>-<ENV>-api-public`,
    `<APP>-<ENV>-tenants-control`, `<APP>-<ENV>-consumer`,
    `<APP>-<ENV>-tenant-data-access`. These names are a cross-stack CONTRACT —
    other stacks reference them by constructed ARN string, never by object.
R9. Tag everything via `cdk.Tags.of(app)`: project, env, managed-by=cdk,
    owner=<ALERT_EMAIL>. No secrets in code/.env/chat. Tenant identity comes ONLY from the verified JWT
    claim — never from bodies, paths, query strings, or client headers.
R10. All Lambdas: arm64, Node.js 22, explicit LogGroup (30-day retention), X-Ray
    tracing ACTIVE, memory 512 / timeout 10s (consumer 30s). Every handler logs
    exactly one structured JSON line per invocation:
    `{requestId, route, tenantId, status, latencyMs}` — this is the log contract,
    and Gate 3 greps for it. (Full Powertools adoption is in the README hardening
    list, not required for the build.)
R11. Request validation: every write route validates its body and returns the
    error envelope `{error:{code,message,requestId}}` with correct status mapping
    (400 validation / 401 / 403 / 404 / 409 conflict / 500 with logged stack, no
    internal leak). Hand-rolled validation is fine; zod optional.
R12. **RESUME PROTOCOL.** If asked to resume mid-build: (1) run
    `aws cloudformation describe-stacks --query "Stacks[].{n:StackName,s:StackStatus}"`,
    (2) `ls gates/`, (3) read the latest gate JSON. Reconcile: the next action is
    the first phase whose gate JSON is missing or red. State your conclusion before
    touching anything. **Leftover-stack rule:** if CloudFormation already has
    <APP>-<ENV>-* stacks but gates/ is empty or the repo is fresh, those are
    leftovers from a PRIOR run — never deploy over them blind. Offer two paths
    and wait for the user's pick: (a) CLEAN SLATE (recommended): delete the edge
    stack first if it is ROLLBACK_COMPLETE (such stacks can only be deleted,
    never updated), then destroy api, then core, waiting for DELETE_COMPLETE on
    each, then start at Phase 0; (b) ADOPT: only if the user confirms this repo
    is the same code those stacks were deployed from.

## STACK OWNERSHIP MAP (prevents the dependency cycle that burned the prior run)

Three stacks, references flow ONE WAY: core → api → edge.

| Resource | Owner | How others reference it |
|---|---|---|
| Cognito pool + client, DynamoDB table | core | object refs forward to api (allowed direction) |
| tenant-data-access role | core | api/consumer reference by **constructed ARN string** |
| ALL Lambda execution roles (api-lambda, api-public, tenants-control, consumer) | **api** | core's trust policy names them by **constructed ARN string** (R8 names) — never by object |
| HTTP API, bus, queues, alarms, dashboard, budget | api | edge references API endpoint forward |
| WAF, CloudFront, site bucket | edge | terminal — nothing references edge |

The rule that makes this safe: **a stack may only hold OBJECT references to
resources in stacks deployed before it. Any backward reference must be a
constructed ARN string** (`arn:aws:iam::${account}:role/<fixed-name>`), which works
because IAM trust-policy *conditions* are matched as strings and never validated
for existence. (Prior run put the lambda role in core, granted it bus permissions
from api → CFN cycle; then trusted a not-yet-existing role ARN as a *principal* →
deploy failure, because principal ARNs ARE existence-checked. Conditions are not.
Use the trust pattern in Phase 2 verbatim.)

## TARGET ARCHITECTURE
(unchanged from v1: CloudFront+WAF → private S3 site + /v1/* → HTTP API with
Cognito JWT authorizer → Lambdas → STS AssumeRole with tenant_id session tag →
DynamoDB LeadingKeys-scoped; EventBridge bus → SQS+DLQ → consumer. Build exactly
this.)

## PHASE 0 — PREFLIGHT
Show: `aws sts get-caller-identity`, `node --version` (>=20), `npx cdk --version`.
Layout (note: single root package.json per R2):
```
/package.json /cdk.json /tsconfig.json
/infra/bin/app.ts /infra/lib/{core,api,edge}-stack.ts /infra/test/
/services/api/handlers/ /services/api/lib/ /services/events/
/scripts/ /gates/ /web/index.html
```
`git init -b main`; install per R3: aws-cdk-lib, constructs, esbuild, ts-node, typescript,
vitest, @types/node, @types/aws-lambda, aws-cdk (dev) + @aws-sdk clients (sts,
dynamodb, lib-dynamodb, cognito-identity-provider, cloudformation, eventbridge,
sqs), ulid. Bootstrap AWS_REGION and us-east-1 if different. One sample vitest
test. npm scripts: build/test/synth.
GATE 0 (`scripts/gate-0.ts` → gates/gate-0.json): cdk synth exits 0; stack count
== 3 measured via `npx cdk ls` (one stack name per line) — do NOT parse synth
stdout for templates, multi-stack synth prints "Supply a stack id" instead of
emitting them; npm test passes.

## PHASE 1 — IDENTITY & TENANCY (core stack only)
Cognito pool `<APP>-<ENV>-users`: featurePlan ESSENTIALS, selfSignUp off, email
sign-in, recovery EMAIL_ONLY, password 12+ all classes, MFA OPTIONAL
(`mfaSecondFactor: { otp: true, sms: false }`), custom attribute
`custom:tenant_id` (string, immutable, maxLen 36), deletionProtection only when
ENV=prod. Group `platform-admins`. App client `<APP>-web`: no secret, SRP +
refresh + ADMIN_USER_PASSWORD_AUTH (smoke-test only — note in README hardening),
access/ID 60min, refresh 30d.

Pre-token Lambda — wire EXACTLY:
`userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, fn, cognito.LambdaVersion.V2_0)`
Handler must inject BOTH `tenant_id` AND `email` (access tokens carry no email
claim natively; /v1/me needs it) into BOTH tokens via
`claimsAndScopeOverrideDetails.{idTokenGeneration,accessTokenGeneration}.claimsToAddOrOverride`,
and THROW if tenant_id attribute is missing (fail-closed login).

`scripts/create-tenant.ts`: --tenant-name --email → tenant_id `t-<8hex>`,
AdminCreateUser with the attribute, DynamoDB META item (skip table write with a
warning until Phase 2 deploys), summary table.

Deploy `<APP>-<ENV>-core` ONLY.
GATE 1 (`scripts/gate-1.ts` → gates/gate-1.json): creates tenant-a with
ADMIN_EMAIL, sets permanent password, admin-initiate-auth, decodes the ACCESS
token payload. Checks: `tenant_id` present; `email` present; `token_use ==
"access"`. Print decoded claims (redact signature).

## PHASE 2 — DATA + HARD TENANT ISOLATION (core stack update)
DynamoDB `<APP>-<ENV>-data`: on-demand, AWS-managed KMS, PITR, TTL `expiresAt`,
PK/SK + GSI1 (GSI1PK/GSI1SK, ALL). deletionProtection only when prod. Key
convention — EVERY PK and GSI1PK starts `TENANT#<tenant_id>#`:
item `TENANT#<t>#ITEM / ITEM#<ulid>`, meta `TENANT#<t>#META / TENANT`,
GSI1 `TENANT#<t>#ITEM#BYSTATUS / <status>#<ulid>`, audit `TENANT#<t>#AUDIT /
AUDIT#<ulid>`.

TenantDataAccessRole — USE THIS TRUST PATTERN VERBATIM (account principal +
PrincipalArn condition; conditions are string-matched so the named roles need not
exist yet, and BOTH AssumeRole and TagSession must be allowed):
```ts
const assumers = ['api-lambda', 'consumer', 'gate-runner']
  .map(n => `arn:aws:iam::${this.account}:role/${appName}-${envName}-${n}`);
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
  }));
```
NEVER trust `lambda.amazonaws.com` here: at runtime the AssumeRole caller is the
execution-role SESSION, not the Lambda service — service-principal trust both
fails at runtime and would let any Lambda in the account mint tenant credentials.

Permissions: Get/Put/Update/Delete/Query/BatchGet/BatchWrite/ConditionCheckItem on
table + `table/index/*`, condition `"ForAllValues:StringLike"
{"dynamodb:LeadingKeys": ["TENANT#${aws:PrincipalTag/tenant_id}#*"]}`. No Scan —
Scan cannot be LeadingKeys-scoped.

Also create in core: `<APP>-<ENV>-gate-runner` role trusted by the deploying
account root, permissions: sts:AssumeRole+TagSession on the tenant role ARN. This
is how gate scripts exercise the tenant role from operator credentials without
widening the Lambda-only trust. (v1 had a contradiction here: "trust ONLY the API
Lambda role" + "gate script assumes the role" cannot both hold.)

`services/api/lib/tenant-credentials.ts`: JWT tenant_id → AssumeRole with
`Tags:[{tenant_id}]`, 900s, per-tenant cache (60s expiry buffer, 100-entry LRU) →
DocumentClient. Application code must ALSO build key conditions from the token
tenant_id — IAM is the backstop, not the only defense.

Deploy `<APP>-<ENV>-core` ONLY.
GATE 2 — the money gate (`scripts/gate-2.ts` chains gate-runner → tenant role;
→ gates/gate-2.json), 5 checks:
(1) as tenant_id=t-aaaa: write+read own item → succeeds;
(2) same creds: Query `PK = TENANT#t-bbbb#ITEM` → AccessDeniedException;
(3) same creds: Query GSI1 `GSI1PK = TENANT#t-bbbb#ITEM#BYSTATUS` →
    AccessDeniedException (GSI leak is the classic miss);
(4) same creds: Scan → AccessDeniedException;
(5) AssumeRole WITHOUT a tenant_id tag, attempt any read → AccessDeniedException
    (proves the policy depends on the tag, not just the role).

## PHASE 3 — API LAYER (api stack)
Create ALL execution roles here with the R8 fixed names (api-lambda, api-public,
tenants-control, consumer). api-lambda: Basic execution + X-Ray +
sts:AssumeRole/TagSession on the tenant role ARN (constructed string) +
events:PutEvents on the bus. api-public (healthz/me): Basic + X-Ray only.
tenants-control: Basic + X-Ray + cognito-idp AdminCreateUser/AdminAddUserToGroup
on the pool ARN + dynamodb:PutItem/GetItem on the table with the same LeadingKeys
condition pattern. consumer: Basic + X-Ray + AssumeRole/TagSession on tenant role.

HTTP API `<APP>-<ENV>-api`, JWT authorizer: issuer
`https://cognito-idp.<REGION>.amazonaws.com/<poolId>`, audience [web client id].
Default stage autoDeploy, throttle 50 rps / burst 100. Access logging to a
dedicated LogGroup (30d) with JSON fields requestId, ip, routeKey, status,
latency, authorizerError=`$context.authorizer.error`. Do NOT log a tenant claim at
the stage — `$context.authorizer.claims.*` is NOT a valid HTTP API access-log
variable (v1's was guessed); tenant correlation comes from the R10 handler log
line. CORS: allowOrigins [http://localhost:5173] (SPA→API rides CloudFront
same-origin; add the CloudFront URL in Phase 5 only if you also keep a direct
API-domain path), Authorization+Content-Type, GET/POST/PUT/DELETE/OPTIONS, maxAge
86400.

Routes (handlers per concern; one NodejsFunction each):
GET /v1/healthz (NO auth, api-public role) · GET /v1/me (api-public) returns
{sub, email, tenant_id, groups} — email exists because Phase 1 injected it ·
POST/GET /v1/items, GET/PUT/DELETE /v1/items/{id} (api-lambda role) ·
POST /v1/tenants (tenants-control role) — REAL implementation: verify
`cognito:groups` claim contains platform-admins (claim may arrive as string,
JSON-ish string, or array — normalize all three), then AdminCreateUser +
tenant_id attr + META item; 403 otherwise. No stubs: if a route exists it works,
if it can't be built say so at the gate.

Handler rules: R11 envelope + status mapping. PUT /v1/items/{id}: optimistic
concurrency (`version` in body, ConditionExpression `version = :v`); update ONLY
fields present in the body (never clobber omitted fields with defaults); when
status changes, ALSO update GSI1SK to `<newStatus>#<id>` (index key must stay
derived). List: GSI1 query, limit 50, base64url nextToken. On create: EventBridge
event source `<APP>.items`, detailType ItemCreated, detail {tenantId,itemId,at} +
hand-rolled EMF metric line for ItemCreated (and ItemDeleted on delete) —
~10-line JSON blob to stdout in CloudWatch EMF format, namespace <APP>.

Deploy `<APP>-<ENV>-api` ONLY.
GATE 3 (`scripts/gate-3.sh` → gates/gate-3.json): no-token POST /v1/items → 401;
with token: POST → 201, GET list → 200 containing it, GET /v1/me → has all 4
fields non-null, PUT with stale version → 409, PUT omitting name → name
preserved (read back), healthz tokenless → 200; 25-request loop → all 2xx; CW
Logs filter on the items LogGroup finds the R10 structured line with tenantId.

## PHASE 4 — ASYNC BACKBONE (api stack update)
Bus `<APP>-<ENV>-bus`; rule ItemCreated → events-queue (CDK wires queue policy).
events-queue: visibility 180s (6× consumer timeout), SSE-SQS, enforceSSL, redrive
maxReceiveCount 3 → events-dlq (14d retention). Consumer: batchSize 10, window
5s, reportBatchItemFailures; returns batchItemFailures ONLY for poison records;
writes audit item PK=TENANT#<t>#AUDIT SK=AUDIT#<ulid>, expiresAt now+90d, via the
tenant role (tagged with the event's tenantId).
Deploy `<APP>-<ENV>-api` ONLY.
GATE 4 (`scripts/gate-4.ts` → gates/gate-4.json): (1) create item via API, poll
consumer LogGroup for the audit-written line; (2) put a malformed event on the
bus, then POLL the DLQ ApproximateNumberOfMessages every 30s for up to 15 min —
3 receives × 180s visibility means the message cannot land sooner; a one-shot
check is a false failure (v1's gate implied immediate; that's wrong).

## PHASE 5 — EDGE (edge stack, us-east-1, crossRegionReferences when regions differ)
Site bucket: BLOCK_ALL, SSE-S3, versioned, enforceSSL; BucketDeployment of
/web/index.html. WAF (CLOUDFRONT scope): CommonRuleSet, KnownBadInputs,
AmazonIpReputationList, rate limit 2000/5min block — metrics + sampled on.
Distribution: default behavior → S3BucketOrigin.withOriginAccessControl, managed
SECURITY_HEADERS, TLS_V1_2_2021, PRICE_CLASS_100, WAF attached. /v1/* behavior →
HttpOrigin('<apiId>.execute-api.<REGION>.amazonaws.com') — BARE DOMAIN, strip
https:// (HttpOrigin rejects URLs with a scheme), ALL_VIEWER_EXCEPT_HOST_HEADER +
CACHING_DISABLED + ALLOW_ALL methods.
SPA fallback: do NOT use distribution-wide errorResponses 403/404→index.html —
that rewrites API errors on /v1/* into 200 HTML (v1 bug). Instead attach a
CloudFront Function (VIEWER_REQUEST, default behavior only): if uri has no "."
and doesn't start with /v1/ → rewrite to /index.html.
Deploy `<APP>-<ENV>-edge` ONLY.
GATE 5 (`scripts/gate-5.sh` → gates/gate-5.json): GET dist / → 200 text/html;
GET dist /some/spa/route → 200 (rewrite works); direct S3 URL → 403; dist
/v1/healthz → 200 JSON; dist /v1/items no token → 401 JSON (NOT 200 HTML — this
is the regression check on the SPA-fallback bug); wafv2 get-web-acl → 4 rules.

## PHASE 6 — OBSERVABILITY (api stack update)
Dashboard `<APP>-<ENV>-overview`: API count/4xx/5xx, p50/p99, Lambda
invocations/errors/duration/concurrent, DDB consumed + throttles, queue depth +
age, DLQ depth, WAF allowed/blocked (us-east-1 metrics). SNS ops-alerts + email
sub (remind me to confirm). Alarms (all → ops-alerts, notBreaching): api-5xx-rate
>1% 5min×2; api-p99 >1500ms 5min×3; lambda-errors sum>0; lambda-throttles sum>0;
dlq-not-empty >=1 (1min); ddb-errors — use
`table.metricSystemErrorsForOperations({operations:[GET_ITEM,PUT_ITEM,QUERY,UPDATE_ITEM,DELETE_ITEM]})`
+ ThrottledRequests, NOT a raw SystemErrors metric with only TableName (that
dimension set never emits data; the v1 alarm was permanently dead); queue-age
>600s.
Deploy `<APP>-<ENV>-api` ONLY.
GATE 6: set-alarm-state on api-5xx-rate → confirm email arrives → returns OK.
gates/gate-6.json records alarm state transitions from describe-alarm-history.

## PHASE 7 — COST (api stack update)
Budget `<APP>-<ENV>-monthly`: 80% ACTUAL + 100% FORECASTED → ALERT_EMAIL. README
cost table (idle + ~1k MAU; itemize WAF/CloudFront/Lambda/DDB/Cognito/CW) + top-3
cost levers. Remind me: activate cost-allocation tags in Billing console (not
CDK-able).
GATE 7: describe-budgets shows both notifications → gates/gate-7.json.

## PHASE 8 — CI/CD (skip if GITHUB_REPO=skip)
OIDC provider token.actions.githubusercontent.com (aud sts.amazonaws.com) + role
gha-deploy-<APP>-<ENV>: StringEquals aud + StringLike
sub=repo:<GITHUB_REPO>:ref:refs/heads/main; permissions sts:AssumeRole on
`arn:aws:iam::<acct>:role/cdk-*` only. ci.yml: PR → ci+lint+test+synth (no
creds); main → id-token:write, configure-aws-credentials, cdk deploy --all
--require-approval never (--all is correct HERE: post-gate CI redeploys
known-good stacks; it is still banned during phased builds).
GATE 8: green Actions URL + describe-stacks UPDATE_COMPLETE.

## DEFINITION OF DONE
Print the checklist with ✅/❌ AND the path of each gates/gate-N.json: 3 stacks
clean + cdk diff empty; tenant_id+email in access token (gate-1); cross-tenant
Query AND GSI-query AND Scan AND untagged-assume denied (gate-2, 5 checks); 401/
CRUD/409/healthz + log-contract (gate-3); bus→queue→consumer + poison→DLQ
(gate-4); CloudFront serves site+API, S3 direct blocked, /v1 errors NOT rewritten
to HTML, WAF 4 rules (gate-5); dashboard + 7 alarms + confirmed email (gate-6);
budget 2 notifications (gate-7); OIDC deploy (gate-8 or skipped); README
(architecture mermaid, runbook, cost table, hardening list: SRP-only flows,
custom domain+ACM, deletion protection everywhere, WAF count→block tuning, full
Powertools adoption, rotate ADMIN_USER_PASSWORD_AUTH off).

## FAILURE PLAYBOOK (consult BEFORE any retry — R7)
| Symptom | Likely cause | Fix |
|---|---|---|
| Permission denied on every command; file-edit tool dead; sandbox wants metadata in a system dir | agent CLI was started in a non-writable directory | R0: create ~/<APP_NAME>, restart the CLI from there — cd alone won't rebind the sandbox |
| Deploy fails: stack is in ROLLBACK_COMPLETE | a prior create failed; ROLLBACK_COMPLETE stacks cannot be updated | aws cloudformation delete-stack, wait DELETE_COMPLETE, deploy fresh |
| Phase 0 but the account already has <APP>-<ENV>-* stacks | leftovers from a prior run | R12 leftover-stack rule: clean-slate destroy (edge → api → core) or adopt — never blind deploy |
| A parameter arrives as "[email protected]" or similar | paste pipeline linkified the value | re-ask for the literal value; echo all parameters back before building |
| npm install ETARGET / notarget | hand-typed version pin | R3: install untagged, read package.json after |
| esbuild/dep not found during NodejsFunction bundling | nested package.json or handlers outside package root | R2: single root package.json; never add workspaces mid-build |
| synth: unknown prop / not assignable | guessed CDK API shape | R4: grep node_modules .d.ts, fix to the real prop |
| CFN "circular dependency between resources/stacks" | backward object reference (late-stack ARN into early stack) | Ownership map: move resource to the later stack; backward refs = constructed ARN strings only |
| Deploy: "Invalid principal in policy" | trust policy names a not-yet-existing role as Principal | principals are existence-checked; conditions are not → AccountPrincipal + aws:PrincipalArn condition (Phase 2 snippet) |
| Runtime AccessDenied calling sts:AssumeRole from Lambda | trust is lambda.amazonaws.com service principal, or missing sts:TagSession | Phase 2 snippet verbatim: account principal + PrincipalArn condition + TagSession statement |
| Isolation test passes when it should fail | unprefixed PK or GSI keys | every PK and GSI1PK starts TENANT#<tenant_id># |
| Gate-2 positive check AccessDenied from operator creds | operator isn't a trusted assumer | chain through gate-runner role (Phase 2) |
| tenant_id or email missing from access token | trigger V1_0, wrong wiring, or LITE plan | addTrigger(PRE_TOKEN_GENERATION_CONFIG, fn, V2_0) + ESSENTIALS; inject email too |
| JWT authorizer always 401 | wrong issuer URL / wrong audience / sent ID token | issuer = exact pool URL; audience = client id; send ACCESS token |
| "Unable to verify secret hash" | client has a secret | recreate client without secret |
| CloudFront→API 403 | Host header forwarded | ALL_VIEWER_EXCEPT_HOST_HEADER |
| HttpOrigin error or colon-in-domain deploy failure | passed URL with scheme | bare domain only — strip https:// |
| API JSON errors arrive as 200 HTML via CloudFront | distribution-wide errorResponses | CloudFront Function URI-rewrite on default behavior; delete errorResponses |
| DLQ count still 0 after one check | polled too early | 3 receives × 180s visibility ≈ 9–12 min; poll 30s up to 15 min |
| Consumer retries forever / DLQ never fills | visibility < 6× timeout or no maxReceiveCount | 180s + maxReceiveCount 3 |
| ddb-errors alarm never has data | SystemErrors lacks Operation dimension | metricSystemErrorsForOperations(...) |
| Access log shows empty tenant field | $context.authorizer.claims.* not valid for HTTP APIs | stage logs authorizer.error only; tenant comes from handler log line (R10) |
| Gate script itself fails to compile (TS strict/unknown) | gate-script typing, not infra | fix the script's types (any/casts) and re-run the gate — do not touch stacks |
| WAF create fails | wrong region | CLOUDFRONT scope = us-east-1 only |
| cross-stack region error | edge refs without flag | crossRegionReferences: true both stacks |
| GHA AssumeRoleWithWebIdentity denied | sub mismatch | repo:<org>/<repo>:ref:refs/heads/main exactly |
| Budget email never arrives | unconfirmed sub / wrong account | confirm email; budgets need management account id |

WORKING AGREEMENT: announce phase → list files → create → deploy THAT stack →
run gate script → paste gates/gate-N.json. "pause" = commit WIP descriptively.
End: Definition of Done with real results + dashboard & CloudFront URLs.
````

## 6. Example Output
Each gate writes machine-checkable evidence. The money gate, `gates/gate-2.json`, exactly as produced by the **live June 10, 2026 run** — all four denials are real `AccessDeniedException`s from the deployed table:

```json
{
  "gate": 2,
  "stack": "launchtest-staging-core",
  "checks": [
    {"name": "own-partition write+read as t-aaaaaaaa", "expected": "item readable", "actual": "item readable", "pass": true},
    {"name": "cross-tenant Query PK=TENANT#t-bbbbbbbb#ITEM", "expected": "AccessDeniedException", "actual": "AccessDeniedException", "pass": true},
    {"name": "cross-tenant GSI1 Query GSI1PK=TENANT#t-bbbbbbbb#ITEM#BYSTATUS", "expected": "AccessDeniedException", "actual": "AccessDeniedException", "pass": true},
    {"name": "Scan with tenant credentials", "expected": "AccessDeniedException", "actual": "AccessDeniedException", "pass": true},
    {"name": "AssumeRole WITHOUT tenant_id tag then read", "expected": "AccessDeniedException", "actual": "AccessDeniedException", "pass": true}
  ],
  "pass": true
}
```

And the final Definition-of-Done print:

```
✅ 3 stacks deployed clean; cdk diff empty
✅ tenant_id + email in ACCESS token            gates/gate-1.json
✅ cross-tenant Query/GSI/Scan/untagged denied   gates/gate-2.json (5/5)
✅ 401 no-token · CRUD · 409 stale-version · healthz public · log contract   gates/gate-3.json
✅ bus → queue → consumer audit write; poison → DLQ after 3 receives          gates/gate-4.json
✅ CloudFront serves site + API; S3 direct 403; /v1 errors stay JSON; WAF 4 rules  gates/gate-5.json
✅ dashboard live; 7 alarms; alert email confirmed                            gates/gate-6.json
✅ budget 80% ACTUAL / 100% FORECASTED           gates/gate-7.json
✅ CI/CD via OIDC (or: skipped per parameter)    gates/gate-8.json
Dashboard: https://console.aws.amazon.com/cloudwatch/...  ·  Site: https://d1234abcd.cloudfront.net
```

Live-run artifacts: the June 10, 2026 run served the site + API at `https://d12p64mor0h8l0.cloudfront.net` (stacks destroyed after evidence capture — rerun the prompt to get yours); the full per-gate JSON evidence is committed under `gates/` in the linked repo.

## 7. Installation Steps
0. **Pick ONE build host and stay on it.** If you build from an EC2 instance over SSM (recommended for long runs): enter with `aws ssm start-session`, then `sudo su - ec2-user`, work in `~/<app-name>` inside `tmux` (survives laptop sleep / session timeouts), and verify `aws sts get-caller-identity` shows the *instance role* with deploy permissions. Your laptop's only jobs: start the session, ship this prompt file up (S3 cp, don't paste 350 lines through the session pipe), click confirmation emails, view URLs. Never run build/AWS commands from the laptop mid-build — its admin identity masks instance-role permission gaps.
1. Empty directory on the build host + credentials that can deploy CDK (CloudFormation, IAM, Cognito, DynamoDB, API Gateway, Lambda, EventBridge, SQS, S3, CloudFront, WAF us-east-1, CloudWatch, SNS, Budgets).
2. Have ready: APP_NAME, ENV (staging for first runs — keeps deletion protection off), AWS_REGION, ALERT_EMAIL, ADMIN_EMAIL, MONTHLY_BUDGET_USD, GITHUB_REPO (or `skip`).
3. Paste the prompt into Kiro CLI from that directory; answer the parameter questions.
4. The agent builds phase by phase. **Your jobs:** confirm the SNS subscription email at Phase 6, click nothing else — and hold the agent to its own rules: one stack per deploy, a `gates/gate-N.json` pasted at every gate.
5. Tear down (staging): `npx cdk destroy --all`, then check for the orphaned access-log group and bootstrap bucket.

## 8. Use Case Examples
- **B2B SaaS foundation**: tenant-per-customer with provable isolation for the security questionnaire — "show us tenant separation" is answered by `gates/gate-2.json`, not a paragraph.
- **Internal multi-team platform**: each team a tenant; LeadingKeys keeps even a buggy internal tool from crossing partitions.
- **Client portal for an agency/firm**: per-client data behind one API; the untagged-assume check proves credentials without tenant context read nothing.
- **Vertical SaaS with compliance exposure** (health, fintech, legal): IAM-layer isolation + alarms + budget + WAF as the day-one posture, not a retrofit.
- **Prompt-engineering reference**: the operating rules (no hand-typed versions, grep-the-types-first, gates-as-scripts, playbook-before-retry, resume protocol) are a reusable harness for driving low-capability coding agents through any large IaC build.

## 9. Troubleshooting Tips
- **Runtime `AccessDenied` calling `sts:AssumeRole` from a Lambda** → someone "fixed" the trust to the `lambda.amazonaws.com` service principal. The runtime caller is the *execution-role session*, not the Lambda service. Restore the account-principal + `aws:PrincipalArn` condition trust (Phase 2 snippet) and keep the explicit `sts:TagSession` statement.
- **Deploy fails "Invalid principal in policy"** → a trust policy names a not-yet-existing role as Principal. Principals are existence-checked; conditions are not — that's why the trust uses `AccountPrincipal` + `aws:PrincipalArn` condition.
- **CFN "circular dependency between stacks"** → an early stack holds an object reference to a later stack's resource. Backward references must be constructed ARN strings (Stack Ownership Map).
- **Gate 2 isolation checks PASS when they should FAIL** → a PK or GSI1PK is missing the `TENANT#<tenant_id>#` prefix; the GSI is the classic miss.
- **Gate 4 DLQ count stays 0** → you checked too early. 3 receives × 180s visibility ≈ 9–12 minutes; the gate script polls up to 15.
- **API errors arrive as 200 HTML through CloudFront** → distribution-wide `errorResponses` SPA fallback. Use the CloudFront Function URI rewrite on the default behavior only.
- **`tenant_id` or `email` missing from the access token** → trigger wired V1_0 or feature plan LITE; needs `addTrigger(PRE_TOKEN_GENERATION_CONFIG, fn, LambdaVersion.V2_0)` + ESSENTIALS.
- **JWT authorizer always 401** → wrong issuer URL, wrong audience, or you sent the ID token; send the ACCESS token.
- **npm install fails ETARGET** → the agent hand-typed a version pin. Rule R3: install untagged, read package.json after.
- **`cdk synth` "unknown prop"** → the agent guessed a CDK API shape. Rule R4: grep the installed `.d.ts` first.
