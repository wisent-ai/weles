import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = resolve(process.env.PROBIERZ_APP_REPO || process.cwd());
const home = homedir();
const skarbiec = join(home, '.stado/bin/skarbiec');
const stado = join(home, '.stado/bin/stado');
const vault = join(home, '.stado/skarbiec.vault.json');
const bridge = join(repo, 'scripts/worker/deploy/weles-skarbiec-local.mjs');
const item = 'weles-figma-personal-access-token';
const field = 'api_key';
const account = 'lukasz.bartoszcze@gmail.com';
const baseEnv = {
  ...process.env,
  PATH: `/usr/local/MacGPG2/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
  GNUPGHOME: join(home, '.gnupg'),
  SKARBIEC_VAULT_FILE: vault,
  SKARBIEC_WELES_CREDENTIAL_COMMAND: bridge,
};

async function run(file, args, options = {}) {
  return exec(file, args, {
    cwd: repo,
    timeout: 15 * 60 * 1000,
    maxBuffer: 1024 * 1024,
    env: baseEnv,
    ...options,
  });
}

async function ownerHasCredential() {
  try {
    await run(skarbiec, ['get', item, '--field', field]);
    return true;
  } catch {
    return false;
  }
}

test('one CLI command acquires a real Figma token through Weles, Stado reads it, and Figma accepts it', async () => {
  const hadCredential = await ownerHasCredential();
  if (hadCredential) await run(skarbiec, ['delete', item]);

  try {
    const acquired = await run(skarbiec, [
      'credential', 'acquire', item,
      '--provider', 'figma',
      '--consumer', 'design-assets',
      '--account', account,
      '--purpose', 'archive Wisent design assets',
      '--signup-origin', 'https://www.figma.com',
      '--local',
    ]);
    const operation = JSON.parse(acquired.stdout);
    expect(operation.ok).toBe(true);
    expect(operation.status).toBe('operation_completed');
    expect(operation.weles.status).toBe('operation_completed');

    const read = await run(stado, [
      'credentials', 'get', item, '--field', field,
    ]);
    const token = Buffer.from(read.stdout.trim(), 'utf8');
    try {
      expect(token.length).toBeGreaterThan(20);
      const response = await fetch('https://api.figma.com/v1/me', {
        headers: { 'X-Figma-Token': token.toString('utf8') },
      });
      expect(response.status).toBe(200);
      const identity = await response.json();
      expect(identity.email).toBe(account);
    } finally {
      token.fill(0);
    }
  } catch (error) {
    if (hadCredential && !(await ownerHasCredential())) {
      await run(skarbiec, ['restore', item]);
    }
    throw error;
  }
});
