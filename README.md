# Multi-Tenant-SaaS-Launchpad v2

**One prompt. Empty AWS account → deployed multi-tenant serverless SaaS foundation,
with tenant isolation enforced by IAM and proven by 9 machine-checked validation gates.**

Paste `docs/PROMPT.md` into an agentic coding CLI (Kiro CLI, or any capable agent)
from an empty directory. The agent builds three CDK stacks phase by phase —
Cognito tenancy → DynamoDB with IAM-enforced isolation → HTTP API → EventBridge/SQS →
CloudFront + WAF → alarms → budget — and **stops at every gate to run a script that
writes `gates/gate-N.json` evidence**. No gate JSON, no progress.

## Why this is different

Most multi-tenant starters enforce tenancy in application code — one missed
`WHERE tenant_id =` and tenant A reads tenant B. Here, **IAM is the backstop**:
every data-plane call runs on STS credentials *session-tagged* with the caller's
`tenant_id` (taken only from the verified JWT, injected by a fail-closed Cognito
pre-token trigger), and the DynamoDB policy's `LeadingKeys` condition makes
cross-tenant access a permission that **does not exist** — on the table, on the
GSI, and Scan isn't granted at all.

And it doesn't claim isolation — it proves it. Gate 2 assumes the tenant role
tagged as tenant-A and demonstrates `AccessDeniedException` on tenant-B's
partition, on the GSI, on Scan, and on an untagged assumption:

```json
{"gate":2,"checks":[
 {"name":"own-partition write+read as t-aaaaaaaa","actual":"item readable","pass":true},
 {"name":"cross-tenant Query","actual":"AccessDeniedException","pass":true},
 {"name":"cross-tenant GSI1 Query","actual":"AccessDeniedException","pass":true},
 {"name":"Scan with tenant creds","actual":"AccessDeniedException","pass":true},
 {"name":"AssumeRole without tenant_id tag","actual":"AccessDeniedException","pass":true}],"pass":true}
```

## Field-tested, not just synthesized

A full run on a clean AWS account (June 10, 2026) deployed everything and the
gates caught **five real defects live** — missing token claim, field-clobbering
PUT, missing log-contract line, a role-name contract violation, and a CloudFront
origin misconfiguration that had left the edge stack in `ROLLBACK_COMPLETE`.
Each was diagnosed via the prompt's failure playbook, fixed, and re-proven green
with zero human debugging. The per-gate JSON evidence from that run is committed
under [`gates/`](gates/).

The prompt itself is **hardened against agent failure modes** observed across
runs: a workspace guard (sandboxes bind to the start directory), no hand-typed
version pins, grep-the-types-before-coding, one-stack-per-deploy, a resume
protocol for dead sessions, leftover-stack reconciliation, and a 22-row failure
playbook the agent must consult before any retry.

## Repo layout & provenance — read this before judging the code

```
gates/                     gate-0..7 JSON evidence from the live run  ← START HERE
infra/lib/core-stack.ts    idiomatic CDK: the isolation core — trust pattern,
                           LeadingKeys condition, gate-runner role, pre-token trigger
infra/lib/api-stack.ts     ADOPTION artifact (see below) + api-template.json
infra/lib/edge-stack.ts    ADOPTION artifact + edge-template.json
services/api/              pre-token.ts + handlers/items.ts (the gate-3-fixed handler)
scripts/                   gate-0..6 scripts — the gates as code
docs/PROMPT.md             the copy-paste prompt (the product)
docs/SUBMISSION.md         full submission document (9 sections)
docs/jury-walkthrough.html narrated walkthrough w/ embedded live-run evidence
docs/runbook.html          step-by-step Run & Prove guide
docs/FINISH-THE-RUN.md     how gates 6–7 were closed (incl. the manual procedure)
```

**Why two of the three stacks are template imports, honestly:** the live run was a
*resume* onto an account that already had deployed stacks. For the core stack the
agent rewrote and redeployed idiomatic CDK (it's the security-critical one — read it).
For the api and edge stacks it **adopted the live CloudFormation templates via
`CfnInclude`** instead of regenerating constructs that might replace live resources —
state reconciliation over blind rebuild. The full deployed definition of every alarm,
queue, route, and budget is auditable in `api-template.json` / `edge-template.json`;
the handler code the gates exercised is in `services/`. Gate-7's evidence was written
by the operator-run verification documented in `docs/FINISH-THE-RUN.md` (the budget
itself shipped in the api stack); gates 0–6 were written by the agent's scripts in
`scripts/`.

**🎬 Demo video (60s):** gate-2's live AccessDenied proofs → the CloudFront site →
JSON healthz through the edge → the honest 401 → the gate manifest. *(link in the
DoraHacks submission)*

**🌐 Hosted jury walkthrough:** [orange-wind-d2b3.acalincarol.workers.dev](https://orange-wind-d2b3.acalincarol.workers.dev/) —
the narrated tour with all live-run evidence embedded (same file as
`docs/jury-walkthrough.html`).

## Run it yourself

1. Open `docs/runbook.html` — it walks the whole flow: prerequisites, the
   laptop-vs-build-host split, where to paste, what each gate must show, timings,
   red flags, teardown.
2. Short version: empty dir on a build host with deploy credentials →
   paste `docs/PROMPT.md` into your agent → answer 7 parameters →
   hold the agent to one stack per deploy and a `gates/gate-N.json` at every stop.
3. Tear down: `npx cdk destroy` edge → api → core (staging has no deletion protection).

**Cost:** scale-to-zero serverless; a full build-and-test day stays in single-digit
dollars, alarm-wired with an AWS Budget tripwire at 80%/100%.

## Definition of Done (from the live run)

✅ 3 stacks deployed clean · ✅ tenant_id + email in the ACCESS token ·
✅ cross-tenant Query / GSI / Scan / untagged-assume all denied at the IAM layer ·
✅ 401 / CRUD / 409 / healthz + structured log contract · ✅ bus → queue → consumer,
poison → DLQ after 3 receives · ✅ CloudFront serves site + API, direct S3 blocked,
API errors stay JSON, WAF 4 rules · ✅ 7 alarms + confirmed email · ✅ budget
80%/100% · ⏭ CI/CD skipped by parameter (OIDC keyless deploy included in the prompt)

---

*Built for AWS "Prompt the Planet" — prompt-engineering for production infrastructure.
The prompt is the product; the gates are the proof.*
