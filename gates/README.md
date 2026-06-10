# Gate evidence — live run, June 10, 2026

Every phase of the build ended with a script exercising the **deployed** system and
writing its verdict here. No gate JSON, no progress — that was the rule the agent
ran under. All eight verdicts: **PASS**.

| File | Gate | What it proves | Highlight |
|---|---|---|---|
| [gate-0.json](gate-0.json) | Scaffold | `cdk synth` = exactly 3 stacks; tests pass | |
| [gate-1.json](gate-1.json) | Identity | ACCESS token carries `tenant_id` + `email`; fail-closed login | caught defect #1 (missing email claim) |
| [gate-2.json](gate-2.json) | **Isolation ★** | cross-tenant Query / **GSI query** / Scan / **untagged AssumeRole** all denied | four raw `AccessDeniedException`s with full ARNs |
| [gate-3.json](gate-3.json) | API contract | 401 / CRUD / 409 / PUT preserves fields / healthz / log contract | caught defects #2 & #3 |
| [gate-4.json](gate-4.json) | Async | bus → queue → consumer audit write; poison → DLQ after 3 receives | caught defect #4 (role-name contract) |
| [gate-5.json](gate-5.json) | Edge | CloudFront serves site + API; direct S3 = 403; API errors stay JSON; WAF 4 rules | recovered the ROLLBACK_COMPLETE stack |
| [gate-6.json](gate-6.json) | Observability | 7 alarms; test alarm → email → OK round-trip | human-confirmed inbox delivery |
| [gate-7.json](gate-7.json) | Cost | budget with 80% ACTUAL + 100% FORECASTED | verified per docs/FINISH-THE-RUN.md |

**Start with [gate-2.json](gate-2.json)** — the isolation proof. The `actual` fields
contain the raw IAM denial strings: the assumed-role session tagged as tenant-A,
denied `dynamodb:Query` on tenant-B's keys, on the table and on the index, with Scan
not granted at all and the untagged assumption rejected. That is tenant isolation
enforced below the application layer, demonstrated against live infrastructure.
