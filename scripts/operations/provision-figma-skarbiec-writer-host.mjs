#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeSkarbiecBinary } from '../_shared/skarbiec-runtime.mjs';

const consumer = 'weles-figma-personal-access-token-writer';
const capability = 'stage:weles-figma-personal-access-token#api_key';
const skarbiec = activeSkarbiecBinary();
const destination = join(
  process.env.HOME,
  '.stado',
  'weles-figma-personal-access-token-writer-skarbiec-token',
);
const temporary = `${destination}.tmp-${process.pid}`;
const revoke = spawnSync(skarbiec, ['token-revoke', consumer], {
  encoding: 'buffer',
  env: process.env,
  maxBuffer: 1024 * 1024,
});
if (Buffer.isBuffer(revoke.stdout)) revoke.stdout.fill(0);
if (Buffer.isBuffer(revoke.stderr)) revoke.stderr.fill(0);
const result = spawnSync(skarbiec, [
  'token-mint',
  consumer,
  '--capabilities',
  capability,
], {
  encoding: 'buffer',
  env: process.env,
  maxBuffer: 1024 * 1024,
});
if (result.status !== 0) {
  throw new Error(`Skarbiec token-mint failed with exit ${result.status}`);
}
let token = result.stdout.toString('utf8').trim();
try {
  if (token.startsWith('{')) {
    const payload = JSON.parse(token);
    token = typeof payload.token === 'string' ? payload.token : '';
  }
  if (token.length < 20 || /\s/.test(token)) {
    throw new Error('Skarbiec token-mint returned an invalid bearer');
  }
  writeFileSync(temporary, token, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  console.log(JSON.stringify({ consumer, capability, installed: true, bytes: token.length }));
} finally {
  result.stdout.fill(0);
  if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0);
  token = '';
  rmSync(temporary, { force: true });
}
