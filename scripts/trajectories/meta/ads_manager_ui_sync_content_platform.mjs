// Sync the Meta Ads account that is accessible in Ads Manager UI into Content Platform.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const DEFAULT_CONTENT_PLATFORM_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/content-platform';
const CONTENT_PLATFORM_DIR = process.env.CONTENT_PLATFORM_DIR || DEFAULT_CONTENT_PLATFORM_DIR;
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const REQUESTED_AD_ACCOUNT_ID = (process.env.AD_ACCOUNT_ID || process.env.META_AD_ACCOUNT_ID || '849988068092449').replace(/^act_/, '');
const FALLBACK_AD_ACCOUNT_ID = (process.env.META_UI_AD_ACCOUNT_ID || '934480871580707').replace(/^act_/, '');
const WAIT_MS = Number(process.env.WAIT_MS || 5000);
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1440x1000';

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadContentPlatformEnv() {
  return {
    ...process.env,
    ...loadEnvFile(resolve(CONTENT_PLATFORM_DIR, '.env.production')),
    ...loadEnvFile(resolve(CONTENT_PLATFORM_DIR, '.env.local')),
  };
}

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function sanitizedUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = parsed.hash ? '#<redacted>' : '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|code|secret|state|session|auth/i.test(key)) parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

async function supabaseFetch(env, path, init = {}) {
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '')}/rest/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message || data?.error || text || `Supabase ${res.status}`);
  return data;
}

function extractAdsManagerSnapshot(rawUrl, bodyText) {
  const url = new URL(rawUrl);
  const act = (url.searchParams.get('act') || '').replace(/^act_/, '');
  const accountMatch = bodyText.match(/Kampanie\s+([^()]{1,120}?)\s+\((\d{6,})\)/i);
  const accountId = act || accountMatch?.[2] || FALLBACK_AD_ACCOUNT_ID;
  const rawAccountName = (accountMatch?.[1] || '').trim();
  const accountName = rawAccountName && rawAccountName !== accountId && !rawAccountName.includes('Raporty dotyczące reklam')
    ? rawAccountName
    : `Meta Ads ${accountId}`;
  const dateRangeMatch = bodyText.match(/Ostatnie\s+\d+\s+dni:\s+(.+?\d{4}\s*[–-]\s*.+?\d{4})/i)
    || bodyText.match(/Last\s+\d+\s+days:\s+(.+?\d{4}\s*[–-]\s*.+?\d{4})/i);
  return {
    accountId,
    accountName,
    url: sanitizedUrl(rawUrl),
    dateRangeLabel: dateRangeMatch?.[1] || null,
    hasCampaignWorkspace: /Kampanie|Campaigns/i.test(bodyText),
    noVisibleCampaignRows: /wykonaj konfigurację, aby wyświetlać reklamy|publish your first campaign|first campaign/i.test(bodyText),
    noBusinessAssetAccess: /Brak zasobów typu konta reklamowe do wyświetlenia|No ad account assets to show/i.test(bodyText),
    bodyExcerpt: bodyText.slice(0, 1800),
  };
}

async function scrapeAdsManager() {
  const s = await WSession.start({
    label: 'meta_ads_manager_ui_sync_content_platform',
    browser: process.env.BROWSER || 'chromium',
    proxy: process.env.PROXY_URL || 'direct',
    persona: stableProfilePersona(),
    userDataDir: USER_DATA_DIR,
    headless: process.env.META_BUSINESS_HEADLESS !== '0',
    pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
  });
  try {
    const requestedUrl = `https://business.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(REQUESTED_AD_ACCOUNT_ID)}`;
    await s.page.goto(requestedUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await s.page.waitForTimeout(WAIT_MS).catch(() => {});
    const data = await s.page.evaluate(() => ({
      url: window.location.href,
      title: document.title || null,
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim(),
    }));
    const snapshot = extractAdsManagerSnapshot(data.url, data.bodyText);
    return {
      ...snapshot,
      title: data.title,
      requestedAccountId: REQUESTED_AD_ACCOUNT_ID,
      redirected: snapshot.accountId !== REQUESTED_AD_ACCOUNT_ID,
    };
  } finally {
    await s.close().catch(() => {});
  }
}

async function getPrimaryUser(env) {
  const rows = await supabaseFetch(
    env,
    '/ad_accounts?platform=eq.meta&is_active=eq.true&select=id,user_id,platform,account_id,account_name,currency,metadata,access_token,refresh_token,is_active&order=created_at.desc',
  );
  const fallbackRows = rows.length ? rows : await supabaseFetch(
    env,
    '/ad_accounts?select=id,user_id,platform,account_id,account_name,currency,metadata,access_token,refresh_token,is_active&order=created_at.desc',
  );
  const primary = fallbackRows.find((row) => row.platform === 'meta') || fallbackRows[0];
  if (!primary?.user_id) throw new Error('No Content Platform ad account row exists to infer user_id');
  return { userId: primary.user_id, rows: fallbackRows };
}

async function upsertUiAccount(env, userId, snapshot) {
  const existingRows = await supabaseFetch(
    env,
    `/ad_accounts?user_id=eq.${encodeURIComponent(userId)}&platform=eq.meta&account_id=eq.${encodeURIComponent(snapshot.accountId)}&select=id,metadata,access_token,refresh_token,currency,account_name`,
  );
  const existing = existingRows[0] || null;
  const body = {
    user_id: userId,
    platform: 'meta',
    account_id: snapshot.accountId,
    account_name: snapshot.accountName || existing?.account_name || `Meta Ads ${snapshot.accountId}`,
    access_token: existing?.access_token || null,
    refresh_token: existing?.refresh_token || null,
    currency: existing?.currency || 'USD',
    is_active: true,
    metadata: {
      ...(existing?.metadata || {}),
      platform_id: `act_${snapshot.accountId}`,
      connection_mode: 'weles_ads_manager_ui',
      source: 'ads_manager_ui_sync_content_platform',
      requested_account_id: snapshot.requestedAccountId,
      redirected_from_requested_account: String(snapshot.redirected),
      date_range_label: snapshot.dateRangeLabel || '',
      has_campaign_workspace: String(snapshot.hasCampaignWorkspace),
      no_visible_campaign_rows: String(snapshot.noVisibleCampaignRows),
      no_business_asset_access: String(snapshot.noBusinessAssetAccess),
      last_ui_sync_at: new Date().toISOString(),
      last_ui_url: snapshot.url,
    },
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    const updated = await supabaseFetch(
      env,
      `/ad_accounts?id=eq.${encodeURIComponent(existing.id)}&select=id,account_id,account_name,metadata`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(body),
      },
    );
    return updated[0];
  }
  const inserted = await supabaseFetch(
    env,
    '/ad_accounts?select=id,account_id,account_name,metadata',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    },
  );
  return inserted[0];
}

function syncViaContentPlatform(snapshot) {
  const args = [
    'exec',
    '--',
    'tsx',
    'scripts/debug/sync-meta-ui-account.ts',
    `--account-id=${snapshot.accountId}`,
    `--account-name=${snapshot.accountName}`,
    `--requested-account-id=${snapshot.requestedAccountId}`,
    `--date-range-label=${snapshot.dateRangeLabel || ''}`,
    `--ui-url=${snapshot.url}`,
    `--has-campaign-workspace=${String(snapshot.hasCampaignWorkspace)}`,
    `--no-visible-campaign-rows=${String(snapshot.noVisibleCampaignRows)}`,
    `--no-business-asset-access=${String(snapshot.noBusinessAssetAccess)}`,
  ];
  const result = spawnSync('npm', args, {
    cwd: CONTENT_PLATFORM_DIR,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Content Platform UI account sync failed with exit ${result.status}`);
  }
  const start = result.stdout.indexOf('{');
  return { raw: result.stdout, parsed: start >= 0 ? JSON.parse(result.stdout.slice(start)) : null };
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  contentPlatformDir: CONTENT_PLATFORM_DIR,
  requestedAccountId: REQUESTED_AD_ACCOUNT_ID,
  fallbackAccountId: FALLBACK_AD_ACCOUNT_ID,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
}, null, 2));

const env = loadContentPlatformEnv();
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log('FAIL: missing Content Platform Supabase env');
  process.exit(1);
}

let exitCode = 0;
try {
  const snapshot = await scrapeAdsManager();
  console.log(JSON.stringify({ stage: 'ads_manager_snapshot', ...snapshot }, null, 2));
  if (snapshot.noBusinessAssetAccess && !snapshot.hasCampaignWorkspace) {
    throw new Error(`Ads Manager did not expose an account workspace for requested account ${REQUESTED_AD_ACCOUNT_ID}`);
  }
  const synced = syncViaContentPlatform(snapshot);
  const row = synced.parsed?.account;
  console.log(JSON.stringify({
    stage: 'content_platform_synced',
    account: row,
  }, null, 2));
  console.log('PASS: Meta Ads Manager UI account synced to Content Platform');
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
}

if (exitCode) process.exit(exitCode);
