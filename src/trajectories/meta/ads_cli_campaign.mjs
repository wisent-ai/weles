// Meta Ads CLI: create a paused campaign through Meta's official CLI.
//
// Official CLI commands follow the shape `meta ads ...`. This wrapper keeps
// Weles queue integration thin: it validates required env, invokes the local
// CLI, and leaves auth/token setup to Meta's CLI (`meta auth status`).
//
// Env:
//   CAMPAIGN_NAME        optional, defaults to timestamped name
//   CAMPAIGN_OBJECTIVE   optional, defaults to OUTCOME_TRAFFIC
//   DAILY_BUDGET_USD     optional daily budget
//   AD_ACCOUNT_ID        optional act_<id> / numeric account id
//   META_ADS_CLI_ARGS    optional full arg string after `meta`; when set, this
//                        bypasses the generated `ads campaign create ...` args
//   SUBMIT               "1" keeps the CLI-created resource as-is. Default is
//                        still safe because Meta CLI creates resources paused.

import { spawn } from 'node:child_process';

const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME || `Wisent ${new Date().toISOString().slice(0, 19)}`;
const CAMPAIGN_OBJECTIVE = process.env.CAMPAIGN_OBJECTIVE || 'OUTCOME_TRAFFIC';
const DAILY_BUDGET_USD = process.env.DAILY_BUDGET_USD;
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
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
  console.log('FAIL: Meta Ads CLI is not installed or not authenticated. Run `pip install meta-ads` and `meta auth status`/auth setup first.');
  if (auth.err || auth.out) console.log((auth.err || auth.out).slice(0, 500));
  process.exit(2);
}

const args = META_ADS_CLI_ARGS ? splitArgs(META_ADS_CLI_ARGS) : [
  'ads', 'campaign', 'create',
  '--name', CAMPAIGN_NAME,
  '--objective', CAMPAIGN_OBJECTIVE,
  ...(DAILY_BUDGET_USD ? ['--daily-budget', String(DAILY_BUDGET_USD)] : []),
  ...(AD_ACCOUNT_ID ? ['--ad-account-id', AD_ACCOUNT_ID] : []),
  '--status', 'PAUSED',
  '--output', 'json',
];

console.log(`[meta-ads-cli] ${META_CLI_BIN} ${args.map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`);
const result = await runMeta(args);
if (result.out) console.log(result.out.trim().slice(0, 4000));
if (result.err) console.error(result.err.trim().slice(0, 2000));
if (result.code !== 0) {
  console.log(`FAIL: meta CLI exited ${result.code}`);
  process.exit(result.code || 1);
}

console.log(`PASS: Meta Ads CLI campaign command completed for "${CAMPAIGN_NAME}"`);
