// Real test of the password Weles generates for an account it registers,
// against a real, isolated Skarbiec vault: a fresh GnuPG home and vault file
// under build/real-tests/identity, made with `skarbiec init`, so the
// operator's vault is never read or written. It runs the built module
// (dist/utils/identity/password.js) as every registration does.
//
// Checks:
//  - with no min_generated_length in the vault policy, generation is refused
//    naming `skarbiec policy-set min_generated_length`;
//  - with the policy set, a password has exactly that length, one character
//    of every class, and `skarbiec policy-check-length` accepts it;
//  - a policy shorter than the number of character classes is refused.
//
// Usage: node tests/identity/password.mjs   (after npm run build)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const stamp = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}-${process.pid}`;
const root = resolve('build', 'real-tests', 'identity', `password-${stamp}`);
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

const skarbiec = (args) => {
  const result = spawnSync('skarbiec', args, {
    encoding: 'utf8',
    env: process.env,
  });
  appendFileSync(
    report,
    `$ skarbiec ${args.join(' ')}\nexit ${result.status}\n${result.stdout}${result.stderr}\n`,
  );
  return result;
};

const init = skarbiec(['init', 'Weles password test']);
if (init.status)
  throw new Error(`skarbiec init refused the isolated vault: ${init.stderr}`);

const { registrationPassword } = await import(
  '../../dist/utils/identity/password.js'
);
const classes = [/[A-Z]/, /[a-z]/, /\d/, /[!@#$%&*]/];

try {
  assert.throws(
    () => registrationPassword(),
    /skarbiec policy-set min_generated_length/,
    'an unset policy is refused naming the command that sets it',
  );

  // The isolated vault states the length of a passphrase Skarbiec itself
  // makes, so the test chooses no length of its own.
  const sample = JSON.parse(
    skarbiec(['generate', '--passphrase', '--words', String(classes.length)])
      .stdout,
  ).passphrase;
  const stated = sample.length;
  assert.ok(
    !skarbiec(['policy-set', 'min_generated_length', String(stated)]).status,
    'the policy is set',
  );
  const password = registrationPassword();
  appendFileSync(
    report,
    `generated length ${password.length}, stated ${stated}\n`,
  );
  assert.equal(password.length, stated, 'the password has the stated length');
  for (const characterClass of classes) assert.match(password, characterClass);
  const checked = JSON.parse(
    skarbiec(['policy-check-length', password]).stdout,
  );
  assert.equal(
    checked.ok,
    true,
    `Skarbiec accepts the password's length: ${JSON.stringify(checked)}`,
  );

  const tooShort = classes.slice(classes.length / classes.length).length;
  assert.ok(
    !skarbiec(['policy-set', 'min_generated_length', String(tooShort)]).status,
  );
  assert.throws(
    () => registrationPassword(),
    /is shorter than the .* character classes/,
    'a policy shorter than the character classes is refused',
  );

  appendFileSync(report, 'PASS\n');
  console.log(`PASS: ${report}`);
} catch (error) {
  appendFileSync(report, `FAIL: ${error?.stack || error}\n`);
  throw error;
}
