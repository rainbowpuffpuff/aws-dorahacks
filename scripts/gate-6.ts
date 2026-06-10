import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

type Check = { name: string; expected: string; actual: string; pass: boolean };

const topicArn = 'arn:aws:sns:us-east-1:109734929935:launchtest-staging-ops-alerts';
const alarmName = 'launchtest-staging-api-5xx-rate';
const email = 'acalincarol@gmail.com';

function aws(args: string[]) {
  return execFileSync('aws', args, { encoding: 'utf8' });
}

function main() {
  mkdirSync('gates', { recursive: true });
  const checks: Check[] = [];

  const alarms = JSON.parse(aws([
    'cloudwatch', 'describe-alarms',
    '--alarm-name-prefix', 'launchtest-staging',
    '--query', 'MetricAlarms[].AlarmName',
    '--output', 'json',
  ]));
  checks.push({
    name: 'seven staging alarms exist',
    expected: '7',
    actual: String(alarms.length),
    pass: alarms.length === 7,
  });

  const dashboard = JSON.parse(aws([
    'cloudwatch', 'get-dashboard',
    '--dashboard-name', 'launchtest-staging-overview',
    '--output', 'json',
  ]));
  checks.push({
    name: 'overview dashboard exists',
    expected: 'launchtest-staging-overview',
    actual: dashboard.DashboardName ?? '',
    pass: dashboard.DashboardName === 'launchtest-staging-overview',
  });

  const subs = JSON.parse(aws([
    'sns', 'list-subscriptions-by-topic',
    '--topic-arn', topicArn,
    '--output', 'json',
  ])).Subscriptions;
  const sub = subs.find((s: any) => s.Endpoint === email);
  checks.push({
    name: 'SNS email subscription confirmed',
    expected: `${email} SubscriptionArn is not PendingConfirmation`,
    actual: sub ? `${sub.Endpoint} ${sub.SubscriptionArn}` : 'missing',
    pass: !!sub && sub.SubscriptionArn !== 'PendingConfirmation',
  });

  aws([
    'cloudwatch', 'set-alarm-state',
    '--alarm-name', alarmName,
    '--state-value', 'ALARM',
    '--state-reason', 'Gate 6 synthetic alarm test',
  ]);
  const history = JSON.parse(aws([
    'cloudwatch', 'describe-alarm-history',
    '--alarm-name', alarmName,
    '--history-item-type', 'StateUpdate',
    '--max-records', '5',
    '--output', 'json',
  ])).AlarmHistoryItems;
  const sawAlarm = history.some((item: any) => item.HistorySummary?.includes('to ALARM'));
  checks.push({
    name: 'api-5xx-rate alarm state transition recorded',
    expected: 'history contains transition to ALARM',
    actual: history.map((item: any) => item.HistorySummary).join(' | '),
    pass: sawAlarm,
  });
  aws([
    'cloudwatch', 'set-alarm-state',
    '--alarm-name', alarmName,
    '--state-value', 'OK',
    '--state-reason', 'Gate 6 synthetic alarm reset',
  ]);

  const result = {
    gate: 6,
    topicArn,
    alarmName,
    checks,
    pass: checks.every((check) => check.pass),
  };
  writeFileSync('gates/gate-6.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exit(1);
}

main();
