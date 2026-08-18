#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const consumer = 'weles-figma-design-assets-exporter';
const capability = 'acquire:weles-figma-personal-access-token#api_key';
const privateKey = process.env.SKARBIEC_WORKLOAD_SIGNING_KEY_FILE;
if (!privateKey) throw new Error('Skarbiec workload signing key is missing');
const publicKey = join(process.env.HOME, '.stado', `figma-export-workload-public-${process.pid}.pem`);
const openssl = '/opt/homebrew/opt/openssl@3/bin/openssl';
const skarbiec = join(process.env.HOME, '.stado', 'bin', 'skarbiec');
try {
  const publicResult = spawnSync(openssl, [
    'pkey', '-in', privateKey, '-pubout', '-out', publicKey,
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env, maxBuffer: 65536 });
  if (publicResult.status !== 0) throw new Error('Unable to derive the Weles workload public key');
  chmodSync(publicKey, 0o600);

  const result = spawnSync(skarbiec, [
    'token-mint', consumer,
    '--capabilities', capability,
    '--workload-public-key-file', publicKey,
    '--replace-capabilities',
  ], { encoding: 'buffer', env: process.env, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error('Skarbiec workload registration failed');
  try {
    const payload = JSON.parse(result.stdout.toString('utf8'));
    console.log(JSON.stringify({
      consumer,
      capability,
      workloadBound: payload.workload_bound === true,
      standingTokenReturned: typeof payload.token === 'string' && payload.token.length > 0,
    }));
  } finally {
    result.stdout.fill(0);
    if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0);
  }
} finally {
  rmSync(publicKey, { force: true });
}
