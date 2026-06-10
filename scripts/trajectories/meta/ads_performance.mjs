// Meta Ads CLI: read campaign/ad performance.
//
// Env:
//   CAMPAIGN_ID         optional campaign id for campaign-scoped insights
//   AD_ACCOUNT_ID       optional act_<id> / numeric account id
//   DATE_PRESET         optional, default last_7d
//   FIELDS              optional comma-separated fields
//   META_ADS_CLI_ARGS   optional full arg string after `meta`; bypasses generated args
//
// Requires Meta's official Ads CLI installed and authenticated.

import { spawn } from 'node:child_process';

const CAMPAIGN_ID = process.env.CAMPAIGN_ID;
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
const DATE_PRESET = process.env.DATE_PRESET || 'last_7d';
const FIELDS = process.env.FIELDS;
const META_ADS_CLI_ARGS = process.env.META_ADS_CLI_ARGS;
const META_CLI_BIN = process.env.META_CLI_BIN || 'meta';

function splitArgs(s) {
  if (!s) return [];
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && i + 1 < s.length) { i += 1; cur += s[i]; }
      else cur += ch;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (q) throw new Error('META_ADS_CLI_ARGS has an unterminated quote');
  if (cur) out.push(cur);
  return out;
}

function runMeta(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(META_CLI_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const auth = await runMeta(['auth', 'status']);
if (auth.code !== 0) {
  console.log('FAIL: Meta Ads CLI is not installed or not authenticated');
  if (auth.err || auth.out) console.log((auth.err || auth.out).slice(0, 500));
  process.exit(2);
}

const args = META_ADS_CLI_ARGS ? splitArgs(META_ADS_CLI_ARGS) : [
  'ads', 'insights', 'get',
  ...(CAMPAIGN_ID ? ['--campaign-id', CAMPAIGN_ID] : []),
  ...(AD_ACCOUNT_ID ? ['--ad-account-id', AD_ACCOUNT_ID] : []),
  '--date-preset', DATE_PRESET,
  ...(FIELDS ? ['--fields', FIELDS] : []),
  '--output', 'json',
];

console.log(`[meta-ads-performance] ${META_CLI_BIN} ${args.map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`);
const result = await runMeta(args);
if (result.out) console.log(result.out.trim().slice(0, 8000));
if (result.err) console.error(result.err.trim().slice(0, 2000));
if (result.code !== 0) {
  console.log(`FAIL: meta CLI exited ${result.code}`);
  process.exit(result.code || 1);
}
console.log('PASS: Meta Ads performance read completed');
