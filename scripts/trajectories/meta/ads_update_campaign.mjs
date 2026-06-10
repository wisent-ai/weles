// Meta Ads CLI: update an existing campaign.
//
// Env:
//   CAMPAIGN_ID         required unless META_ADS_CLI_ARGS is set
//   CAMPAIGN_NAME       optional new name
//   STATUS              optional PAUSED | ACTIVE | ARCHIVED | DELETED
//   DAILY_BUDGET_USD    optional budget value if supported by installed CLI
//   AD_ACCOUNT_ID       optional act_<id> / numeric account id
//   META_ADS_CLI_ARGS   optional full arg string after `meta`; bypasses generated args
//   SUBMIT              must be "1" to set ACTIVE. Other updates are allowed.

import { spawn } from 'node:child_process';

const CAMPAIGN_ID = process.env.CAMPAIGN_ID;
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME;
const STATUS = process.env.STATUS;
const DAILY_BUDGET_USD = process.env.DAILY_BUDGET_USD;
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
const META_ADS_CLI_ARGS = process.env.META_ADS_CLI_ARGS;
const SUBMIT = process.env.SUBMIT === '1';
const META_CLI_BIN = process.env.META_CLI_BIN || 'meta';

if (!META_ADS_CLI_ARGS && !CAMPAIGN_ID) {
  console.log('FAIL: CAMPAIGN_ID or META_ADS_CLI_ARGS required');
  process.exit(1);
}
if (STATUS && /^active$/i.test(STATUS) && !SUBMIT) {
  console.log('FAIL: refusing to activate campaign without SUBMIT=1');
  process.exit(1);
}

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
  'ads', 'campaign', 'update', CAMPAIGN_ID,
  ...(CAMPAIGN_NAME ? ['--name', CAMPAIGN_NAME] : []),
  ...(STATUS ? ['--status', STATUS.toUpperCase()] : []),
  ...(DAILY_BUDGET_USD ? ['--daily-budget', String(DAILY_BUDGET_USD)] : []),
  ...(AD_ACCOUNT_ID ? ['--ad-account-id', AD_ACCOUNT_ID] : []),
  '--output', 'json',
];

console.log(`[meta-ads-update] ${META_CLI_BIN} ${args.map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`);
const result = await runMeta(args);
if (result.out) console.log(result.out.trim().slice(0, 8000));
if (result.err) console.error(result.err.trim().slice(0, 2000));
if (result.code !== 0) {
  console.log(`FAIL: meta CLI exited ${result.code}`);
  process.exit(result.code || 1);
}
console.log(`PASS: Meta Ads campaign update completed${CAMPAIGN_ID ? ` (${CAMPAIGN_ID})` : ''}`);
