# DoraHacks submission — paste-ready copy

## Title
Multi-Tenant-SaaS-Launchpad: IAM-Enforced Tenant Isolation on AWS, Proven by 9 Validation Gates

## Vision (one-liner)
One copy-paste prompt takes an empty AWS account to a deployed multi-tenant serverless SaaS foundation — tenant isolation enforced by IAM session tags + DynamoDB LeadingKeys, and proven (not claimed) by 9 machine-checked gates whose JSON evidence ships in the repo.

## Project Description
→ Paste the full contents of `docs/SUBMISSION.md` (the 9-section document: Title, Description & Use Case, Category, AWS Services, **The Complete Prompt**, Example Output with real run evidence, Installation, Use Cases, Troubleshooting).

## Category
Code Development

## Track / Tags
AWS CDK · IAM · Cognito · DynamoDB · API Gateway · EventBridge · SQS · CloudFront · WAF · CloudWatch · multi-tenant · serverless · prompt-engineering

## GitHub URL
https://github.com/<you>/multi-tenant-saas-launchpad   ← fill in after push

## Demo video (the 3%-of-field differentiator)
~60s screen capture: gate-2.json's four real AccessDeniedExceptions → live CloudFront URL →
/v1/healthz returns JSON → tokenless /v1/items returns 401 JSON (not rewritten HTML) →
`ls gates/` + the Definition-of-Done print. Upload to YouTube (unlisted is fine), link in the form.

## Suggested closing line for the description field
> Most entries ship a prompt. This one ships a prompt **plus the deployed proof that
> its guardrails hold**: a live run where the gates caught five real defects —
> including a broken CloudFront stack recovered via the prompt's own failure
> playbook — and ended with every isolation denial machine-verified at the IAM layer.
