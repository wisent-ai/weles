// Real test of the --provider argument of `weles app-password` and `weles
// account-security`, through the built CLI (dist/cli.js) as an operator
// runs it.
//
// Every start names its provider, as `login` and `developer-certificate`
// do: a start without --provider, or with a provider Weles does not issue
// through, is refused with the usage status before any worker is reached, and
// reading a run back with --run refuses a --provider (a run is named by its id
// alone). Nothing here starts a run, so no account is touched.
//
// Usage: node tests/security/provider-flag.mjs   (WELES_CLI selects the
//   built entry point, default dist/cli.js)

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const cli = process.env.WELES_CLI || 'dist/cli.js';
const run = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = join('build', 'real-tests', 'security', run);
mkdirSync(root, { recursive: true });
const report = join(root, 'report.txt');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
const dirty =
  spawnSync('git', ['diff', '--quiet']).status === 0 ? '' : ' (dirty)';
writeFileSync(report, `revision: ${revision}${dirty}\nbinary: ${cli}\n`);

const USAGE_STATUS = spawnSync(
  process.execPath,
  [cli, 'app-password', '--unknown-flag'],
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
    console.error(
      `FAIL: weles ${args.join(' ')} exited ${result.status}: ${result.stderr}`,
    );
    process.exit(1);
  }
  appendFileSync(report, `ok: refused with: ${expected}\n`);
}

refuse(
  ['app-password', '--login-role', 'test-role', '--organization', 'test-org'],
  'app-password needs --provider naming the identity provider that issues it; Weles issues through google',
);
refuse(
  [
    'app-password',
    '--provider',
    'microsoft',
    '--login-role',
    'test-role',
    '--organization',
    'test-org',
  ],
  'app-password needs --provider naming the identity provider that issues it; Weles issues through google',
);
refuse(
  ['app-password', '--run', 'run-test', '--provider', 'google'],
  '--run reads a started run back and takes no --organization or --provider',
);
refuse(
  ['account-security', '--login-role', 'test-role'],
  'account-security needs --provider naming the identity provider whose account it reads; Weles reads google',
);
refuse(
  ['account-security', '--run', 'run-test', '--provider', 'google'],
  '--run reads a started run back and takes no --provider',
);

appendFileSync(report, 'PASS\n');
console.log(`PASS: ${report}`);
