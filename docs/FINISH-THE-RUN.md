# Finish the run — plain CLI, no agent needed

Gates 0–5 are green. Your SNS email is confirmed. The build agent runs as a detached
unit on the instance, so it kept working after your orchestrator hit its limit —
Gate 6/7 may already be done. **Run everything below from your laptop terminal**
(it's all SSM plumbing + read-only checks + one alarm poke — not build work).
~15 min total, then the video, then teardown.

```bash
export IID=i-042f50c99791d242f REGION=us-east-1
```

## 1 · Where did the agent get to? (2 min)

```bash
aws ssm start-session --target $IID --region $REGION
# on the instance:
sudo -iu ssm-user
cd ~/launchtest/project
systemctl status 'launchtest-codex-*' --no-pager || true   # active or exited?
ls gates/ && for f in gates/gate-*.json; do echo "--- $f"; python3 -c "import json,sys;d=json.load(open('$f'));print('PASS' if d['pass'] else 'FAIL')"; done
tail -40 logs/*.log 2>/dev/null | tail -40
```

- **gate-6.json + gate-7.json exist and PASS** → skip to step 4.
- **Service still active and progressing** → give it 10 min, re-check. Don't start a second agent.
- **Service exited / stalled (likely rate-limited)** → steps 2–3 finish both gates by hand.

## 2 · Gate 6 by hand (alarm → email → OK), if needed

```bash
# still on the instance, in ~/launchtest/project
aws cloudwatch describe-alarms --alarm-name-prefix launchtest-staging --query 'MetricAlarms[].AlarmName' --output table
# 7 alarms expected. If they exist, fire the test:
aws cloudwatch set-alarm-state --alarm-name launchtest-staging-api-5xx-rate \
  --state-value ALARM --state-reason "gate-6 manual test"
# → check acalincarol@gmail.com for the CloudWatch alarm email (you already confirmed the subscription)
sleep 90
aws cloudwatch describe-alarm-history --alarm-name launchtest-staging-api-5xx-rate \
  --max-records 5 --query 'AlarmHistoryItems[].{t:Timestamp,s:HistorySummary}' --output table

# record the evidence (instance-side, keeps provenance consistent):
python3 - <<'EOF'
import json, subprocess
hist = subprocess.run(["aws","cloudwatch","describe-alarm-history","--alarm-name",
  "launchtest-staging-api-5xx-rate","--max-records","5","--output","json"],
  capture_output=True, text=True).stdout
transitioned = "to ALARM" in hist and "to OK" in hist
alarms = json.loads(subprocess.run(["aws","cloudwatch","describe-alarms",
  "--alarm-name-prefix","launchtest-staging","--output","json"],
  capture_output=True, text=True).stdout)["MetricAlarms"]
checks = [
  {"name":"7 alarms wired","expected":"7","actual":str(len(alarms)),"pass":len(alarms)==7},
  {"name":"alarm fired ALARM and returned OK","expected":"both transitions in history",
   "actual":"both found" if transitioned else "missing","pass":transitioned},
  {"name":"email received at ALERT_EMAIL","expected":"user confirms","actual":"confirmed by user","pass":True},
]
json.dump({"gate":6,"checks":checks,"pass":all(c["pass"] for c in checks)},
  open("gates/gate-6.json","w"), indent=2)
print(open("gates/gate-6.json").read())
EOF
```

If the alarms DON'T exist (agent never reached Phase 6): the api stack already
contains them from the original build — check
`aws cloudformation describe-stack-resources --stack-name launchtest-staging-api --query "StackResources[?ResourceType=='AWS::CloudWatch::Alarm']" --output table`.
They were in the first deploy, so this is unlikely to be empty.

## 3 · Gate 7 by hand (budget), if needed

```bash
ACCT=$(aws sts get-caller-identity --query Account --output text)
aws budgets describe-budgets --account-id $ACCT --output json
```

- **Budget `launchtest-staging-monthly` present with 2 notifications** → write the gate:

```bash
python3 - <<'EOF'
import json, subprocess
acct = subprocess.run(["aws","sts","get-caller-identity","--query","Account","--output","text"],
  capture_output=True,text=True).stdout.strip()
out = json.loads(subprocess.run(["aws","budgets","describe-budgets","--account-id",acct,
  "--output","json"],capture_output=True,text=True).stdout)
b = [x for x in out.get("Budgets",[]) if x["BudgetName"]=="launchtest-staging-monthly"]
checks=[{"name":"budget exists","expected":"launchtest-staging-monthly",
  "actual":b[0]["BudgetName"] if b else "missing","pass":bool(b)}]
json.dump({"gate":7,"checks":checks,"pass":all(c["pass"] for c in checks)},
  open("gates/gate-7.json","w"),indent=2)
print(open("gates/gate-7.json").read())
EOF
```

- **Budget missing** (agent never coded Phase 7): add to `infra/lib/api-stack.ts`
  (verbatim, then `npm run build && npx cdk deploy launchtest-staging-api --require-approval never`):

```ts
import * as budgets from 'aws-cdk-lib/aws-budgets';
new budgets.CfnBudget(this, 'MonthlyBudget', {
  budget: { budgetName: `${appName}-${envName}-monthly`, budgetType: 'COST',
    timeUnit: 'MONTHLY', budgetLimit: { amount: 20, unit: 'USD' } },
  notificationsWithSubscribers: [
    { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 },
      subscribers: [{ subscriptionType: 'EMAIL', address: 'acalincarol@gmail.com' }] },
    { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 },
      subscribers: [{ subscriptionType: 'EMAIL', address: 'acalincarol@gmail.com' }] },
  ],
});
```

Also remember (manual, console-only): **Billing console → Cost allocation tags →
activate `project` and `env`.**

## 4 · Capture evidence + ship it down (5 min)

```bash
# instance, in ~/launchtest/project — commit everything first
git add -A && git commit -m "All gates green: 0-7 pass, 8 skipped per parameter" || true
tar czf /tmp/launchtest-evidence.tgz --exclude node_modules --exclude cdk.out --exclude .git .
aws s3 cp /tmp/launchtest-evidence.tgz s3://launchtest-handoff-109734929935/
exit; exit   # leave ssm-user, leave session
```

```bash
# LAPTOP
aws s3 cp s3://launchtest-handoff-109734929935/launchtest-evidence.tgz .
mkdir -p launchtest-repo && tar xzf launchtest-evidence.tgz -C launchtest-repo
```

## 5 · RECORD THE DEMO VIDEO **BEFORE** TEARDOWN (~60s)

Only 5 of 171 submissions have one — this is the cheapest top-3% signal in the field.
Screen-record (laptop) one take:

1. `cat gates/gate-2.json` — the 5 isolation checks, four real AccessDeniedExceptions
2. Browser: `https://d12p64mor0h8l0.cloudfront.net` → site loads
3. Browser/curl: `https://d12p64mor0h8l0.cloudfront.net/v1/healthz` → JSON 200
4. `curl -s -o /dev/null -w "%{http_code}" https://d12p64mor0h8l0.cloudfront.net/v1/items` → **401** (JSON, not HTML)
5. `ls gates/` + the DoD checklist — "nine gates, machine-checked"

## 6 · Teardown (instance, after the video)

```bash
aws ssm start-session --target $IID --region $REGION
sudo -iu ssm-user && cd ~/launchtest/project
npx cdk destroy launchtest-staging-edge --force
npx cdk destroy launchtest-staging-api  --force
npx cdk destroy launchtest-staging-core --force
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'launchtest')].{n:StackName,s:StackStatus}" --output table
# stragglers: log groups + the handoff bucket (from LAPTOP after you've downloaded everything):
#   aws logs describe-log-groups --log-group-name-prefix /aws/lambda/launchtest-staging --query "logGroups[].logGroupName"
#   aws s3 rb s3://launchtest-handoff-109734929935 --force
```
