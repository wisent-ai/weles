// Real test of how Weles ranks proxy providers for an action, against a real,
// isolated Skarbiec vault: a fresh GnuPG home and vault file under
// build/real-tests/proxy, created with `skarbiec init` (which generates the
// owner and recovery keys there), so the operator's vault is never read or
// written. It runs the built modules (dist/proxy/capability.js,
// dist/state/skarbiec-records.js) as a worker does.
//
// Checks:
//  - with no proxy_rate_cards setting every declared provider is unpriced and
//    none is ranked, and the no-exit sentence says so;
//  - a rate card pricing two providers ranks exactly those, cheapest first,
//    and names every other declared provider as unpriced;
//  - an exact pass for the action ranks above a cheaper untried provider, and
//    a recorded failure moves a provider to `failing`;
//  - a setting whose stored value is not JSON is an error naming the setting,
//    not an empty rate card;
//  - a vault that cannot be read is an error, not an empty rate card.
//
// The two prices are the smallest and largest finite numbers JavaScript has:
// only their order matters here.
//
// Usage: node tests/proxy/rate_cards.mjs   (after npm run build)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  constants,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const stamp = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = resolve('build', 'real-tests', 'proxy', `rate-cards-${stamp}`);
const gnupg = join(root, 'gnupg');
mkdirSync(gnupg, { recursive: true, mode: constants.S_IRWXU });
const report = join(root, 'report.txt');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
const dirty = spawnSync('git', ['status', '--porcelain'], {
  encoding: 'utf8',
}).stdout.trim()
  ? ' (dirty)'
  : '';
writeFileSync(report, `revision: ${revision}${dirty}\n`);

process.env.GNUPGHOME = gnupg;
process.env.SKARBIEC_VAULT_FILE = join(root, 'vault.json');

const init = spawnSync('skarbiec', ['init', 'Weles rate-card test'], {
  encoding: 'utf8',
  env: process.env,
});
appendFileSync(
  report,
  `$ skarbiec init\nexit ${init.status}\n${init.stdout}${init.stderr}\n`,
);
if (init.status)
  throw new Error(`skarbiec init refused the isolated vault: ${init.stderr}`);

const { ALL_PROVIDERS, noExitCause, rankByCapability, recordOutcome } =
  await import('../../dist/proxy/capability.js');
const {
  listCredentialItems,
  readDocument,
  readSetting,
  writeDocument,
  writeSetting,
} = await import('../../dist/state/skarbiec-records.js');
const ACTION = 'testplatform_register';

try {
  const empty = await rankByCapability(ACTION);
  assert.deepEqual(
    empty.candidates,
    [],
    'nothing is ranked without a rate card',
  );
  assert.deepEqual(
    [...empty.unpriced].sort(),
    [...ALL_PROVIDERS].sort(),
    'every declared provider is unpriced',
  );
  assert.match(
    noExitCause(ACTION, [], empty.failing, empty.unpriced),
    /no rate in the proxy_rate_cards setting: \w/,
  );

  const [cheap, dear, ...rest] = ALL_PROVIDERS;
  writeSetting('proxy_rate_cards', {
    rates: {
      [dear]: { per_gb: Number.MAX_VALUE },
      [cheap]: { per_gb: Number.MIN_VALUE },
    },
  });
  const priced = await rankByCapability(ACTION);
  assert.deepEqual(
    priced.candidates.map((c) => c.provider),
    [cheap, dear],
    'cheapest first among untried',
  );
  assert.deepEqual(
    [...priced.unpriced].sort(),
    [...rest].sort(),
    'every other provider is named unpriced',
  );

  await recordOutcome(
    dear,
    ACTION,
    'completed',
    'register_succeeded',
    'testplatform',
  );
  const passed = await rankByCapability(ACTION);
  assert.deepEqual(
    passed.candidates.map((c) => c.provider),
    [dear, cheap],
    'an exact pass outranks a cheaper untried provider',
  );
  assert.equal(
    passed.candidates.find((c) => c.provider === dear).standing,
    'pass',
  );

  await recordOutcome(cheap, ACTION, 'failed', 'ip_blocked', 'testplatform');
  const failed = await rankByCapability(ACTION);
  assert.deepEqual(
    failed.candidates.map((c) => c.provider),
    [dear],
  );
  assert.deepEqual(
    failed.failing,
    [cheap],
    'a recorded failure is named as failing',
  );

  const setting = listCredentialItems()
    .map((row) => row.id)
    .find((id) => readDocument(id).context?.setting_key === 'proxy_rate_cards');
  assert.ok(
    setting,
    'the rate card is a runtime-setting record in the isolated vault',
  );
  const stored = readDocument(setting);
  writeDocument(setting, {
    ...stored,
    fields: { ...stored.fields, value_json: '{not json' },
  });
  appendFileSync(
    report,
    'wrote a value that is not JSON into the rate card record\n',
  );
  await assert.rejects(
    rankByCapability(ACTION),
    /Weles setting proxy_rate_cards holds no JSON value/,
  );
  assert.throws(
    () => readSetting('proxy_rate_cards', { rates: {} }),
    /proxy_rate_cards holds no JSON value/,
  );

  rmSync(process.env.SKARBIEC_VAULT_FILE);
  await assert.rejects(
    rankByCapability(ACTION),
    (error) => !/no rate in/.test(String(error)),
    'an unreadable vault is an error of its own, never an empty rate card',
  );

  appendFileSync(report, 'result: passed\n');
  console.log(`passed; report ${report}`);
} catch (error) {
  appendFileSync(report, `result: failed: ${error.stack}\n`);
  throw error;
}
