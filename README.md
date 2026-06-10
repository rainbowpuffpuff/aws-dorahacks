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

## Repo layout

```
infra/            CDK v2 (TypeScript): core / api / edge stacks   ← agent-generated
services/         Lambda handlers (api, events consumer)          ← agent-generated
scripts/          gate-N scripts + create-tenant                  ← agent-generated
gates/            gate-N.json evidence from the live run          ← the proof
web/              placeholder SPA
docs/PROMPT.md            the copy-paste prompt (start here)
docs/SUBMISSION.md        full submission document (9 sections)
docs/runbook.html         step-by-step Run & Prove guide (open in browser)
docs/jury-walkthrough.html  project walkthrough with embedded live-run
                            evidence: dashboards, alarms, stack states,
                            the firing DLQ alarm, the gate-6 alarm email
```

**Demo video:** 60-second screen capture (gate-2 denials → live CloudFront URL →
JSON healthz → honest 401 → the gate manifest) — link added on submission.

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
