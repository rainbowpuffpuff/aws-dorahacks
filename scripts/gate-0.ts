import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

interface Check {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

function run(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync([command, ...args].join(' '), {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const synth = run('npx', ['cdk', 'synth']);
const ls = run('npx', ['cdk', 'ls']);
const test = run('npm', ['test']);

const lsOutput = ls.stdout.length > 0 ? ls.stdout : ls.stderr;
const stackLines = lsOutput
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => /^launchtest-staging-(core|api|edge)$/.test(line));

const checks: Check[] = [
  {
    name: 'cdk synth exits 0',
    expected: '0',
    actual: String(synth.status),
    pass: synth.status === 0,
  },
  {
    name: 'stack count via cdk ls',
    expected: '3',
    actual: String(stackLines.length),
    pass: stackLines.length === 3,
  },
  {
    name: 'npm test exits 0',
    expected: '0',
    actual: String(test.status),
    pass: test.status === 0,
  },
];

const report = {
  gate: 0,
  checks,
  stacks: stackLines,
  diagnostics: {
    cdkLsStatus: ls.status,
    cdkLsStderr: ls.stderr.trim(),
  },
  pass: checks.every((check) => check.pass),
};

mkdirSync('gates', { recursive: true });
writeFileSync('gates/gate-0.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (!report.pass) {
  process.exit(1);
}
