// A subscription imported before accounts were recorded beside their grants
// still says which account it is: the member id Brama's pool minted carries
// the account's slug. Weles resolves it forward — every candidate login's own
// account_ref slugged the same way — and refuses when nothing or more than
// one matches.
//
// Until 2026-09-19 it refused every such member with
// `subscription_identity_missing`, so the automatic sign-in that exists to
// replace their burnt grants could not start, and Brama answered every agent
// `all bounded credentials were rejected by the provider`.
//
// The vault here is a real Skarbiec vault of this test's own, written with
// the real binary; nothing reads or writes the operator's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const repo = resolve(import.meta.dirname, '../..');
const root = join(repo, '.wisent-output/subscription-identity');
mkdirSync(root, { recursive: true });
const vaultDir = mkdtempSync(join(root, 'vault-'));
const vault = join(vaultDir, 'vault.json');
const skarbiec = process.env.WELES_SKARBIEC_BIN || join(homedir(), '.stado', 'bin', 'skarbiec');

function run(args, input) {
  return execFileSync(skarbiec, args, {
    input,
    encoding: 'utf8',
    env: { ...process.env, SKARBIEC_VAULT_FILE: vault },
  });
}

function login(id, accountRef) {
  run(['set-json', id, '--type', 'login'], JSON.stringify({
    schema: 'skarbiec.item.v2',
    kind: 'login',
    context: { account_ref: accountRef, login_method: 'email_password', provider: 'claude-code' },
    fields: { username: accountRef, password: 'not-a-real-password' },
  }));
  run(['retag', id, '--tags', 'brama:provider:claude-code']);
}

function subscription(id) {
  const item = `provider:claude-code:${id}`;
  run(['set-json', item, '--type', 'token'], JSON.stringify({
    schema: 'skarbiec.item.v2',
    kind: 'token',
    context: { provider: 'claude-code' },
    fields: { token: '{}' },
  }));
  run(['retag', item, '--tags',
    `brama:subscription,brama:provider:claude-code,brama:id:${id}`]);
  return item;
}

function select(subscriptionId) {
    const previous = {
        vault: process.env.SKARBIEC_VAULT_FILE,
        binary: process.env.SKARBIEC_BIN,
    };
    process.env.SKARBIEC_VAULT_FILE = vault;
    // The same executable this test seeded the vault with: the resolver
    // honours a launcher-provided binary, and a test is that launcher here.
    process.env.SKARBIEC_BIN = skarbiec;
    try {
        const { selectLoginAccount } = require(join(repo, 'dist/utils/login-accounts.js'));
        return selectLoginAccount('claude-code', null, subscriptionId);
    } finally {
        for (const [name, value] of [['SKARBIEC_VAULT_FILE', previous.vault], ['SKARBIEC_BIN', previous.binary]]) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}
const require = (await import('node:module')).createRequire(import.meta.url);

test('a member id names its account when the item records none', () => {
  run(['init', 'weles-subscription-identity-test']);
  login('login-wisent', 'lukasz.bartoszcze@wisent.ai');
  login('login-gmail', 'controlyourai@gmail.com');
  subscription('brama-sub-held-claude-code-lukasz-bartoszcze-wisent-ai');
  const account = select('brama-sub-held-claude-code-lukasz-bartoszcze-wisent-ai');
  assert.equal(account.accountRef, 'lukasz.bartoszcze@wisent.ai');
  assert.equal(account.loginItem, 'login-wisent');
});

test('a member id that matches no login is still refused', () => {
  subscription('brama-sub-held-claude-code-nobody-example-com');
  assert.throws(
    () => select('brama-sub-held-claude-code-nobody-example-com'),
    (error) => error.code === 'subscription_identity_missing',
  );
});

// The refusal is read by a person holding a burnt grant, and until it named
// the logins this vault holds and the flag that binds one, the candidates had
// to be found with `skarbiec list` before the sign-in could be retried.
test('the refusal names the logins it could not choose between', () => {
  subscription('brama-sub-held-claude-code-nobody-example-com');
  assert.throws(
    () => select('brama-sub-held-claude-code-nobody-example-com'),
    (error) => error.message.includes('--login-item')
      && error.message.includes('login-wisent')
      && error.message.includes('login-gmail'),
  );
});

test('the operator keeps their vault', () => {
  assert.notEqual(vault, join(homedir(), '.stado', 'skarbiec.vault.json'));
  rmSync(vaultDir, { recursive: true, force: true });
});
