// Meta Ads CLI/browser: read campaign/ad performance.
//
// Env:
//   CAMPAIGN_ID         optional campaign id for campaign-scoped insights
//   AD_ACCOUNT_ID       optional act_<id> / numeric account id
//   DATE_PRESET         optional, default last_7d
//   FIELDS              optional comma-separated fields
//   META_ADS_CLI_ARGS   optional full arg string after `meta`; bypasses generated args
//
// Uses Meta's official Ads CLI when installed/authenticated. Otherwise falls
// back to the logged-in Ads Manager browser profile.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { generatePersona } from '../../../dist/browser/persona.js';
import { graphRequest } from './_marketing_api.mjs';

const CAMPAIGN_ID = process.env.CAMPAIGN_ID;
const AD_ACCOUNT_ID = (process.env.AD_ACCOUNT_ID || process.env.META_ADS_COMPANY_ACCOUNT_ID || '').replace(/^act_/, '');
const BUSINESS_ID = process.env.BUSINESS_ID || process.env.META_BUSINESS_ID;
const AD_ACCOUNT_NAME = process.env.AD_ACCOUNT_NAME || process.env.META_ADS_ACCOUNT_NAME;
const DATE_PRESET = process.env.DATE_PRESET || 'last_7d';
const FIELDS = process.env.FIELDS;
const META_ADS_CLI_ARGS = process.env.META_ADS_CLI_ARGS;
const META_CLI_BIN = process.env.META_CLI_BIN || 'meta';
const META_CLI_REQUIRED = process.env.META_CLI_REQUIRED === '1';
const META_API_ONLY = process.env.META_API_ONLY === '1';
const HAS_META_TOKEN = !!(process.env.META_ACCESS_TOKEN || process.env.FACEBOOK_ACCESS_TOKEN || process.env.META_SYSTEM_USER_ACCESS_TOKEN);
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
mkdirSync(USER_DATA_DIR, { recursive: true });

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
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

async function browserPerformance() {
  if (!AD_ACCOUNT_ID) {
    console.log('FAIL: AD_ACCOUNT_ID or META_ADS_COMPANY_ACCOUNT_ID required for browser fallback');
    process.exit(1);
  }
  const params = new URLSearchParams({ act: AD_ACCOUNT_ID });
  if (BUSINESS_ID) params.set('business_id', BUSINESS_ID);
  const url = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?${params}`;
  const s = await WSession.start({
    label: 'meta_ads_performance',
    browser: process.env.BROWSER || 'chromium',
    proxy: process.env.PROXY_URL || 'direct',
    persona: stableProfilePersona(),
    userDataDir: USER_DATA_DIR,
    pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
  });
  try {
    await s.goto(url);
    await s.wait(10);
    const current = s.page.url?.() ?? '';
    const text = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (/login|checkpoint|security/i.test(current)) {
      console.log(`FAIL: Meta Ads browser session is not logged in (${current})`);
      process.exit(2);
    }
    const visibleAccount = text.match(/([^\n]*\((\d{6,})\))/);
    const visibleLabel = visibleAccount?.[1]?.trim() || null;
    const visibleId = visibleAccount?.[2] || null;
    console.log(`[meta-ads-performance] browser account=${visibleLabel || 'unknown'} url=${current}`);
    if (visibleId && visibleId !== AD_ACCOUNT_ID) {
      console.log(`FAIL: wrong Meta ad account selected; expected=${AD_ACCOUNT_ID} actual=${visibleId}`);
      process.exit(1);
    }
    if (AD_ACCOUNT_NAME && visibleLabel && !visibleLabel.toLowerCase().includes(AD_ACCOUNT_NAME.toLowerCase())) {
      console.log(`FAIL: wrong Meta ad account label; expected contains=${AD_ACCOUNT_NAME} actual=${visibleLabel}`);
      process.exit(1);
    }
    const rows = await s.page.evaluate(() => Array.from(document.querySelectorAll('[role="row"], tr'))
      .map((row) => (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 50)).catch(() => []);
    console.log(JSON.stringify({ account: visibleLabel, rows, empty: /Brak wyników|No results|Nie utworzono/i.test(text) }, null, 2).slice(0, 8000));
    console.log('PASS: Meta Ads performance read completed (browser)');
  } finally {
    await s.close().catch(() => {});
  }
}

async function apiPerformance() {
  if (!AD_ACCOUNT_ID && !CAMPAIGN_ID) {
    console.log('FAIL: AD_ACCOUNT_ID/META_ADS_COMPANY_ACCOUNT_ID or CAMPAIGN_ID required for Meta API performance');
    process.exit(1);
  }
  const fields = FIELDS || 'campaign_id,campaign_name,impressions,clicks,spend,actions,cost_per_action_type,date_start,date_stop';
  const params = {
    fields,
    date_preset: DATE_PRESET,
    level: process.env.LEVEL || (CAMPAIGN_ID ? 'campaign' : 'campaign'),
    filtering: process.env.FILTERING_JSON ? JSON.parse(process.env.FILTERING_JSON) : undefined,
    limit: process.env.LIMIT || 500,
  };
  const path = CAMPAIGN_ID ? `/${CAMPAIGN_ID}/insights` : `/${AD_ACCOUNT_ID.startsWith('act_') ? AD_ACCOUNT_ID : `act_${AD_ACCOUNT_ID}`}/insights`;
  console.log(`[meta-ads-performance] API ${path} fields=${fields}`);
  await graphRequest('GET', path, params, { execute: true, label: 'meta-ads-performance-api' });
  console.log('PASS: Meta Ads performance read completed (api)');
}

if (HAS_META_TOKEN || META_API_ONLY) {
  try {
    await apiPerformance();
    process.exit(0);
  } catch (e) {
    console.log('FAIL:', e.message?.slice(0, 1200));
    process.exit(1);
  }
}

const auth = await runMeta(['auth', 'status']).catch((e) => ({ code: 127, out: '', err: e.message || String(e) }));
if (auth.code !== 0) {
  if (META_CLI_REQUIRED) {
    console.log('FAIL: Meta Ads CLI is not installed or not authenticated');
    if (auth.err || auth.out) console.log((auth.err || auth.out).slice(0, 500));
    process.exit(2);
  }
  console.log('[meta-ads-performance] Meta CLI unavailable; using browser fallback');
  await browserPerformance();
  process.exit(0);
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
