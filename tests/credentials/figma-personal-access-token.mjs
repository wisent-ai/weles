import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { activeSkarbiecBinary } from '../../scripts/_shared/skarbiec-runtime.mjs';

const exec = promisify(execFile);
const repo = resolve(process.env.WELES_TEST_REPO || process.cwd());
const home = homedir();
const skarbiec = activeSkarbiecBinary();
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
  assert.equal(operation.ok, true);
  assert.equal(operation.status, 'operation_completed');
  assert.equal(operation.weles.status, 'operation_completed');

  const read = await run(stado, [
    'credentials', 'get', item, '--field', field,
  ]);
  const token = Buffer.from(read.stdout.trim(), 'utf8');
  try {
    assert(token.length > 20, 'Stado returned no Figma token');
    const response = await fetch('https://api.figma.com/v1/me', {
      headers: { 'X-Figma-Token': token.toString('utf8') },
    });
    assert.equal(response.status, 200);
    const identity = await response.json();
    assert.equal(identity.email, account);
  } finally {
    token.fill(0);
  }
  process.stdout.write('figma credential journey: acquired through Weles, read through Stado, accepted by Figma\n');
} catch (error) {
  if (hadCredential && !(await ownerHasCredential())) {
    await run(skarbiec, ['restore', item]);
  }
  throw error;
}
