// Real test of the --provider argument of `weles password` and `weles
// security`, through the built CLI as an operator runs it.
//
// Every start names its provider, as `login` and `certificate` do: a start
// without --provider, or with a provider Weles does not issue through, is
// refused with the usage status before any worker is reached, and reading a
// run back with --run refuses a --provider (a run is named by its id alone).
// Nothing here starts a run, so no account is touched.
//
// Usage: WELES_CLI=<built dist/cli.js> node tests/security/provider-flag.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const cli = process.env.WELES_CLI;
if (!cli) {
  throw new Error(
    'WELES_CLI names the built entry point under test (dist/cli.js); none is assumed',
  );
}
const run = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = join('build', 'real-tests', 'security', run);
mkdirSync(root, { recursive: true });
const report = join(root, 'report.txt');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
const dirty = spawnSync('git', ['diff', '--quiet']).status ? ' (dirty)' : '';
writeFileSync(report, `revision: ${revision}${dirty}\nbinary: ${cli}\n`);

const USAGE_STATUS = spawnSync(
  process.execPath,
  [cli, 'password', '--unknown-flag'],
  { encoding: 'utf8' },
).status;

function refuse(args, expected) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WELES_WORKER_API_BASE: '', WELES_WORKER_TOKEN: '' },
  });
  appendFileSync(
    report,
    `$ weles ${args.join(' ')}\nexit: ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}\n\n`,
  );
  if (result.status !== USAGE_STATUS || !result.stderr.includes(expected)) {
    appendFileSync(
      report,
      `FAIL: expected the usage status ${USAGE_STATUS} and '${expected}'\n`,
    );
    throw new Error(
      `weles ${args.join(' ')} exited ${result.status}: ${result.stderr}`,
    );
  }
  appendFileSync(report, `ok: refused with: ${expected}\n`);
}

refuse(
  ['password', '--login-role', 'test-role', '--organization', 'test-org'],
  'password needs --provider naming the identity provider that issues it; Weles issues through google',
);
refuse(
  [
    'password',
    '--provider',
    'microsoft',
    '--login-role',
    'test-role',
    '--organization',
    'test-org',
  ],
  'password needs --provider naming the identity provider that issues it; Weles issues through google',
);
refuse(['password', '--run', 'run-test', '--provider', 'google'], '--run');
const accountCreation = [
  'password',
  '--provider',
  'google',
  '--login-item',
  'test-login',
  '--organization',
  'test-org',
];
refuse(accountCreation, '--account');
refuse([...accountCreation, '--account', ' '], '--account');
refuse(
  ['password', '--run', 'run-test', '--account', 'mailbox@example.com'],
  '--run',
);
refuse(
  ['security', '--login-role', 'test-role'],
  'security needs --provider naming the identity provider whose account it reads; Weles reads google',
);
refuse(
  ['security', '--run', 'run-test', '--provider', 'google'],
  '--run reads a started run back and takes no --provider',
);
// The retired hyphenated names are no commands: each is refused as unknown.
for (const retired of [
  'app-password',
  'account-security',
  'developer-certificate',
]) {
  refuse([retired, '--provider', 'google'], retired);
}

appendFileSync(report, 'PASS\n');
console.log(`PASS: ${report}`);
