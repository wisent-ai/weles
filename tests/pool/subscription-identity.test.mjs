import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '../..');
const executable = realpathSync(process.env.SKARBIEC_BIN || join(homedir(), '.local/bin/skarbiec'));
const work = join(homedir(), '.stado/work/weles-identity-tests');
mkdirSync(work, { recursive: true });

function fixture() {
  const root = mkdtempSync(join(work, 'identity-'));
  const environment = { ...process.env, HOME: root, GNUPGHOME: join(root, 'gnupg'),
    SKARBIEC_BIN: executable, SKARBIEC_VAULT_FILE: join(root, 'vault.json'),
    SKARBIEC_AUDIT_FILE: join(root, 'audit.jsonl'), STADO_CONFIG: join(root, 'absent-stado.json') };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('SKARBIEC_') && !['SKARBIEC_BIN', 'SKARBIEC_VAULT_FILE', 'SKARBIEC_AUDIT_FILE'].includes(name)) delete environment[name];
  }
  mkdirSync(environment.GNUPGHOME, { mode: 0o700 });
  function vault(arguments_, document) {
    const result = spawnSync(executable, arguments_, {
      env: environment, encoding: 'utf8', input: document ? JSON.stringify(document) : undefined,
    });
    assert.equal(result.status, 0, `Skarbiec ${arguments_[0]} failed: ${result.stderr}`);
    return result.stdout;
  }
  vault(['init', 'subscription-identity-test']);
  function doctor() {
    const result = spawnSync(process.execPath, ['dist/cli.js', 'doctor'], {
      cwd: repository, env: environment, encoding: 'utf8',
    });
    assert.equal(result.error, undefined);
    const report = JSON.parse(result.stdout);
    assert.ok(report.subscriptionAuthentication, `No account diagnostics: ${result.stderr}`);
    return { state: report.subscriptionAuthentication, status: result.status };
  }
  return { root, environment, vault, doctor };
}

// Local fixture identities, not provider accounts. This story proves vault
// persistence and account resolution, not a successful OAuth login.
test('doctor resolves an account from Skarbiec and survives renaming both items', () => {
  const f = fixture();
  try {
    const email = 'isolated-account@example.invalid';
    f.vault(['set-json', 'login-original', '--type', 'login'], {
      schema: 'skarbiec.item.v2', kind: 'login',
      context: { provider: 'codex', account_ref: email, login_method: 'google_sso' },
      fields: { username: email, password: 'isolated-fixture-password' },
    });
    f.vault(['set-json', 'subscription-original', '--type', 'bundle', '--tags',
      'brama:subscription,brama:provider:codex,brama:id:isolated-subscription,brama:agent:isolated-agent'], {
      schema: 'skarbiec.item.v2', kind: 'bundle',
      context: { provider: 'codex', account_ref: email }, fields: { value: { type: 'oauth_account' } },
    });
    const initial = f.doctor().state;
    assert.deepEqual(initial.errors, []);
    assert.equal(initial.accounts.length, 1);
    assert.equal(initial.accounts[0].loginItem, 'login-original');
    assert.equal(initial.accounts[0].subscriptionId, 'isolated-subscription');
    const copy = {
      schema: 'skarbiec.item.v2', kind: 'login',
      context: { provider: 'codex', account_ref: email, login_method: 'google_sso' },
      fields: { username: email, password: 'isolated-fixture-password' },
    };
    f.vault(['set-json', 'login-copy', '--type', 'login'], copy);
    const equivalent = f.doctor().state;
    assert.deepEqual(equivalent.errors, []);
    assert.equal(equivalent.accounts[0].accountRef, email);
    copy.fields.password = 'a-different-fixture-password';
    f.vault(['set-json', 'login-copy', '--type', 'login'], copy);
    const conflicting = f.doctor();
    assert.equal(conflicting.status, 1);
    assert.equal(conflicting.state.errors[0].code, 'skarbiec_login_ambiguous');
    f.vault(['delete', 'login-copy']);
    f.vault(['rename', 'login-original', 'login-renamed']);
    f.vault(['rename', 'subscription-original', 'subscription-renamed']);
    const renamed = f.doctor().state;
    assert.deepEqual(renamed.errors, []);
    assert.equal(renamed.accounts[0].loginItem, 'login-renamed');
    assert.equal(renamed.accounts[0].subscriptionItem, 'subscription-renamed');
    assert.equal(renamed.accounts[0].accountRef, email);
    assert.equal(JSON.parse(f.vault(['get', 'login-renamed'])).fields.username, email);
    f.vault(['delete', 'login-renamed']);
    const missing = f.doctor();
    assert.equal(missing.status, 1);
    assert.deepEqual(missing.state.accounts, []);
    assert.equal(missing.state.errors[0].code, 'skarbiec_login_missing');
    assert.equal(missing.state.errors[0].subscription_item, 'subscription-renamed');
    assert.equal(JSON.parse(f.vault(['get', 'subscription-renamed'])).context.account_ref, email);
  } finally {
    spawnSync('gpgconf', ['--kill', 'all'], { env: f.environment });
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('doctor follows a subscription source and refuses a broken reference', () => {
  const f = fixture();
  try {
    f.vault(['set-json', 'source-login', '--type', 'login'], {
      schema: 'skarbiec.item.v2', kind: 'login',
      context: { login_method: 'google_sso' },
      fields: { username: 'source-account@example.invalid', password: 'isolated-fixture-password' },
    });
    const descriptor = {
      schema: 'skarbiec.item.v2', kind: 'bundle', context: {},
      fields: { value: { metadata: JSON.stringify({ CODEX_SERVICE_CREDENTIAL_ID: 'source-login' }) } },
    };
    f.vault(['set-json', 'source-descriptor', '--type', 'bundle'], descriptor);
    f.vault(['set-json', 'source-subscription', '--type', 'bundle', '--tags',
      'brama:subscription,brama:provider:codex,brama:id:source-subscription,brama:agent:isolated-agent'], {
      schema: 'skarbiec.item.v2', kind: 'bundle', context: { source_item: 'source-descriptor' },
      fields: { value: { type: 'oauth_account' } },
    });
    const resolved = f.doctor().state;
    assert.deepEqual(resolved.errors, []);
    assert.equal(resolved.accounts[0].accountRef, 'source-account@example.invalid');
    assert.equal(resolved.accounts[0].loginItem, 'source-login');
    f.vault(['delete', 'source-descriptor']);
    const missing = f.doctor().state;
    assert.equal(missing.errors[0].code, 'subscription_source_missing');
    assert.equal(missing.errors[0].source_item, 'source-descriptor');
    f.vault(['set-json', 'source-descriptor', '--type', 'bundle'], {
      ...descriptor, context: { source_item: 'source-descriptor' }, fields: { value: {} },
    });
    assert.equal(f.doctor().state.errors[0].code, 'subscription_source_cycle');
    assert.equal(JSON.parse(f.vault(['get', 'source-login'])).fields.username, 'source-account@example.invalid');
  } finally {
    spawnSync('gpgconf', ['--kill', 'all'], { env: f.environment });
    rmSync(f.root, { recursive: true, force: true });
  }
});
