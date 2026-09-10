// Apple Ads trajectory runner backed by `asc ads`.
//
// Weles action names use `apple_<verb>`, where APPLE_ADS_ACTION is the verb
// parsed by dispatch.ts, e.g. `ads_campaigns` or `ads_reports_keywords`.
//
// Mutations are intentionally gated: create/update/delete/auth-login/raw
// non-GET requests require APPLE_ADS_CONFIRM=1, WRITE_CONFIRM=1, or SUBMIT=1.

import { spawn } from 'node:child_process';
import { ASC_BIN, action, withOutput } from './run/args.mjs';
import { argsForAction } from './run/actions.mjs';

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ASC_BIN, withOutput(args), { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const args = await argsForAction();
console.log(`[apple-ads] ${ASC_BIN} ${withOutput(args).map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`);

const result = await run(args);
if (result.out) console.log(result.out.trim().slice(0, 30000));
if (result.err) console.error(result.err.trim().slice(0, 4000));
if (result.code !== 0) {
  console.log(`FAIL: asc ads exited ${result.code}`);
  process.exit(result.code || 1);
}

console.log(`PASS: Apple Ads ${action} completed`);
