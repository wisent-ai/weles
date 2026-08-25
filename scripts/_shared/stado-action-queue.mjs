import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SAFE_ACTION = /^[a-z][a-z0-9_]{0,127}$/;

function stadoBinary() {
  return process.env.WELES_STADO_BIN || join(homedir(), '.stado', 'bin', 'stado');
}

function runnerPath() {
  return join(homedir(), 'weles', 'scripts', 'worker', 'stado-action-runner.mjs');
}

export function enqueueWelesAction({ action, accountItem = '', params = {}, priority = 0, pinnedHost = '' }) {
  if (!SAFE_ACTION.test(String(action))) throw new Error(`invalid Weles action: ${action}`);
  if (accountItem && !/^weles-[a-z0-9][a-z0-9-]{0,126}$/.test(String(accountItem))) {
    throw new Error('accountItem must be an exact Weles Skarbiec item id');
  }
  if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error('params must be an object');
  const payload = Buffer.from(JSON.stringify({ action, accountItem, params }), 'utf8').toString('base64url');
  const command = `${process.execPath} ${runnerPath()} ${payload}`;
  const args = ['submit', command, '--priority', String(priority)];
  if (pinnedHost) args.push('--pinned-host', pinnedHost);
  const result = spawnSync(stadoBinary(), args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, HOME: homedir() },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Stado refused Weles action ${action}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const match = String(result.stdout).match(/\b[0-9a-f]{8}\b/i);
  if (!match) throw new Error(`Stado accepted ${action} but returned no job id`);
  return match[0];
}
