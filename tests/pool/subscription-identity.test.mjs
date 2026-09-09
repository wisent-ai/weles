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
