// Real Skarbiec, in a vault of the journey's own: what a login item declares
// about its sign-in is read from every place it may be written, and two places
// that disagree are refused naming both. Reads through the real login readers
// (dist/utils/login-accounts.js, so run after building Weles).
//
// - a login method in the item's context and a different one in its
//   weles:login-method: tag is refused as login_record_conflict, naming both;
// - an account in the context and a different username is refused the same
//   way, while one that differs only in letter case is the same account;
// - a credential value that is not JSON is refused as login_record_unreadable
//   naming the item, never read as a value without metadata;
// - places that agree are read as their one value.
//
// Run: node tests/identity/login-records.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';
import { activeSkarbiecBinary } from '../../src/_shared/skarbiec-runtime.mjs';

const evidence = await evidenceFor('login-records');
const { report } = evidence;
const root = fileURLToPath(new URL('../../', import.meta.url));
let failure;
let initialized = false;

function accepted(program, args, input) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    cwd: root,
    env: process.env,
    input,
  });
  report.operations.push({
    command: [program, ...args],
    exit_status: result.status,
    signal: result.signal,
    stderr: result.stderr,
    error: result.error?.message,
  });
  assert.equal(result.error, undefined);
  assert.ok(!result.status && !result.signal, result.stderr);
  return result.stdout;
}

try {
  const directory = join(root, 'build/real-tests/login-records', randomUUID());
  const gnupg = join(directory, 'gnupg');
  mkdirSync(gnupg, { recursive: true, mode: constants.S_IRWXU });
  process.env.GNUPGHOME = gnupg;
  process.env.SKARBIEC_VAULT_FILE = join(directory, 'vault.json');
  report.vault_file = process.env.SKARBIEC_VAULT_FILE;
  const skarbiec = activeSkarbiecBinary();
  report.skarbiec_binary_sha256 = createHash('sha256')
    .update(readFileSync(skarbiec))
    .digest('hex');
  accepted(skarbiec, ['init', 'Weles login record test']);
  initialized = true;

  // The vault file is read when the records module loads, so it is imported
  // only after the journey's own vault is named.
  const { metadata } = await import(
    '../../dist/utils/login-accounts/records.js'
  );
  const login = (document, tags) => {
    const id = `weles-login-records-${randomUUID()}`;
    accepted(
      skarbiec,
      ['set', id, '--type', 'login', '--tags', tags.join(',')],
      JSON.stringify(document),
    );
    return { id, kind: 'login', tags };
  };
  const refused = (item, code, ...named) => {
    assert.throws(
      () => metadata(item, 'claude'),
      (error) => {
        report.operations.push({
          read: item.id,
          refused: error.code,
          message: error.message,
        });
        assert.equal(error.code, code, error.message);
        for (const word of named)
          assert.ok(error.message.includes(word), error.message);
        return true;
      },
    );
  };
  const address = `login-${randomUUID()}@example.com`;

  refused(
    login(
      {
        context: { login_method: 'google_sso' },
        fields: { username: address },
      },
      ['weles:login-method:email_password'],
    ),
    'login_record_conflict',
    'login_method',
    'context.login_method (google_sso)',
    'the weles:login-method: tag (email_password)',
  );
  refused(
    login(
      {
        context: { account_ref: address },
        fields: { username: `other-${address}` },
      },
      [],
    ),
    'login_record_conflict',
    'account_ref',
    'fields.username',
  );
  refused(
    login({ fields: { username: address, value: 'not json' } }, []),
    'login_record_unreadable',
    'fields.value',
  );

  const agreeing = metadata(
    login(
      {
        context: {
          login_method: 'google_sso',
          account_ref: address.toUpperCase(),
        },
        fields: { username: address },
      },
      ['weles:login-method:google_sso'],
    ),
    'claude',
  );
  assert.equal(agreeing.login_method, 'google_sso');
  assert.equal(agreeing.account_ref, address.toUpperCase());
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = initialized ? 'failed' : 'blocked';
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
} finally {
  await evidence.finish();
}
if (failure) throw failure;
