// Google Ads REST API: read campaign performance with GAQL.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID      required
//   GOOGLE_ADS_DEVELOPER_TOKEN  required
//   GOOGLE_ADS_ACCESS_TOKEN     optional; falls back to `gcloud auth print-access-token`
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID optional manager account id
//   GOOGLE_ADS_API_VERSION      optional, default v24
//   GOOGLE_ADS_QUERY            optional GAQL query
//   DATE_PRESET                 optional when using default query, default LAST_7_DAYS
//   CAMPAIGN_ID                 optional filter when using default query

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../../dist/browser/persona.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { customerId, googleAdsPost } from './_api.mjs';

const cid = customerId();
const datePreset = process.env.DATE_PRESET || 'LAST_7_DAYS';
const campaignFilter = process.env.CAMPAIGN_ID ? ` AND campaign.id = ${String(process.env.CAMPAIGN_ID).replace(/\D/g, '')}` : '';
const browserFallback = process.env.GOOGLE_ADS_BROWSER_FALLBACK !== '0';
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
mkdirSync(USER_DATA_DIR, { recursive: true });
const query = process.env.GOOGLE_ADS_QUERY || `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    metrics.impressions,
    metrics.clicks,
    metrics.cost_micros,
    metrics.conversions,
    metrics.conversions_value,
    segments.date
  FROM campaign
  WHERE segments.date DURING ${datePreset}${campaignFilter}
  ORDER BY segments.date DESC
  LIMIT 1000
`;

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

async function browserPerformance() {
  const url = `https://ads.google.com/aw/campaigns?ocid=${encodeURIComponent(cid)}`;
  const s = await WSession.start({
    label: 'google_ads_performance',
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
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(current)) {
      console.log(`FAIL: Google Ads browser session is not logged in (${current})`);
      process.exit(2);
    }
    const rows = await s.page.evaluate(() => Array.from(document.querySelectorAll('[role="row"], material-list-item, tr'))
      .map((row) => (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 80)).catch(() => []);
    console.log(JSON.stringify({
      customer: cid,
      url: current,
      rows,
      empty: /No campaigns|No results|There are no campaigns|Nie ma kampanii/i.test(text),
    }, null, 2).slice(0, 12000));
    console.log('PASS: Google Ads performance read completed (browser)');
  } finally {
    await s.close().catch(() => {});
  }
}

try {
  console.log(`[google-ads-performance] customer=${cid} query=${query.replace(/\s+/g, ' ').trim()}`);
  const json = await googleAdsPost(`/customers/${cid}/googleAds:searchStream`, { query });
  console.log(JSON.stringify(json, null, 2).slice(0, 20000));
  console.log('PASS: Google Ads performance read completed');
} catch (e) {
  if (browserFallback && /GOOGLE_ADS_ACCESS_TOKEN|required|gcloud|GOOGLE_ADS_DEVELOPER_TOKEN|401|403/i.test(e.message || '')) {
    console.log(`[google-ads-performance] API unavailable; using browser fallback (${String(e.message || '').slice(0, 240)})`);
    await browserPerformance();
    process.exit(0);
  }
  console.log('FAIL:', e.message?.slice(0, 1200));
  process.exit(1);
}
