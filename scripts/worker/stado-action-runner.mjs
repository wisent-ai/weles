#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const encoded = process.argv[2] || '';
if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('one base64url action payload is required');
const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
if (!/^[a-z][a-z0-9_]{0,127}$/.test(String(payload.action || ''))) throw new Error('invalid Weles action');
if (payload.accountItem && !/^weles-[a-z0-9][a-z0-9-]{0,126}$/.test(String(payload.accountItem))) {
  throw new Error('invalid Weles account item');
}
if (!payload.params || Array.isArray(payload.params) || typeof payload.params !== 'object') throw new Error('invalid Weles action params');

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { resolveTrajectory, paramsToEnv } = await import(`${repo}/dist/worker/dispatch.js`);
const trajectory = resolveTrajectory(payload.action);
if (!trajectory) throw new Error(`no Weles trajectory for ${payload.action}`);
const params = payload.accountItem
  ? { ...payload.params, login_item: payload.accountItem }
  : payload.params;

const env = {
  ...process.env,
  ...paramsToEnv(params, payload.action, trajectory),
  WSESSION_LABEL: payload.action,
  ACTION_LOG_ID: process.env.WC_JOB_ID || process.env.STADO_JOB_ID || '',
};
const child = spawn(process.execPath, [trajectory], { cwd: repo, env, stdio: 'inherit' });
const signal = (name) => {
  if (!child.killed) child.kill(name);
};
process.once('SIGINT', () => signal('SIGINT'));
process.once('SIGTERM', () => signal('SIGTERM'));
const status = await new Promise((done, fail) => {
  child.once('error', fail);
  child.once('exit', (code, childSignal) => done({ code, childSignal }));
});
if (status.childSignal) process.kill(process.pid, status.childSignal);
process.exitCode = status.code ?? 1;
