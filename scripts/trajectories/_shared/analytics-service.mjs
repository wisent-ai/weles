import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { SessionStore } from '../../../dist/session/store.js';
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause, humanScroll } from '../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { googleSso, getGoogleSsoCreds } from './services/google_sso.mjs';

const UMAMI_BASE = 'https://cloud.umami.is';
const GA_BASE = 'https://analytics.google.com/analytics/web/';
const WRITE_CONFIRM = process.env.WRITE_CONFIRM === '1';

const ACTIONS = {
  umami_login: { platform: 'umami', risk: 'verify', url: UMAMI_BASE, required: [], objective: 'Verify the Umami browser session is authenticated.' },
  umami_create_website: { platform: 'umami', risk: 'write', url: `${UMAMI_BASE}/settings/websites`, required: ['DOMAIN', 'DISPLAY_NAME'], objective: 'Create an Umami website entry.' },
  umami_find_website: { platform: 'umami', risk: 'read', url: `${UMAMI_BASE}/settings/websites`, required: ['DOMAIN_OR_NAME'], objective: 'Find an Umami website row by domain or name.' },
  umami_get_website_id: { platform: 'umami', risk: 'read', url: `${UMAMI_BASE}/settings/websites`, required: ['DOMAIN_OR_NAME'], objective: 'Read the Umami website id.' },
  umami_get_tracking_snippet: { platform: 'umami', risk: 'read', url: `${UMAMI_BASE}/settings/websites`, required: ['WEBSITE_ID'], objective: 'Read the Umami tracking snippet.' },
  umami_update_website_settings: { platform: 'umami', risk: 'write', url: `${UMAMI_BASE}/settings/websites`, required: ['WEBSITE_ID', 'SETTINGS_PATCH'], objective: 'Update Umami website settings.' },
  umami_verify_tracking_script: { platform: 'umami', risk: 'verify', url: () => input('SITE_URL', 'https://www.needher.ai'), required: ['SITE_URL', 'WEBSITE_ID'], objective: 'Verify the target site serves the expected Umami script.' },
  umami_verify_realtime_event: { platform: 'umami', risk: 'verify', url: UMAMI_BASE, required: ['SITE_URL', 'WEBSITE_ID'], objective: 'Verify a visit can appear in Umami realtime analytics.' },
  umami_view_realtime: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID'], objective: 'Open Umami realtime analytics.' },
  umami_view_summary: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami summary metrics.' },
  umami_view_pages: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami page performance.' },
  umami_view_referrers: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami referrers.' },
  umami_view_events: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami events.' },
  umami_track_custom_event: { platform: 'umami', risk: 'verify', url: () => input('SITE_URL', 'https://www.needher.ai'), required: ['SITE_URL', 'EVENT_NAME'], objective: 'Trigger or verify a custom Umami event on the target site.' },
  umami_view_sessions: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami sessions.' },
  umami_create_report: { platform: 'umami', risk: 'write', url: UMAMI_BASE, required: ['WEBSITE_ID', 'REPORT_TYPE', 'DATE_RANGE'], objective: 'Create an Umami report.' },
  umami_view_funnels: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'FUNNEL_NAME', 'DATE_RANGE'], objective: 'Read Umami funnel performance.' },
  umami_view_goals: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami goals.' },
  umami_view_user_journeys: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami user journeys.' },
  umami_view_retention: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami retention.' },
  umami_view_cohorts: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami cohorts.' },
  umami_view_utm_campaigns: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami UTM campaign performance.' },
  umami_api_query: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['ENDPOINT', 'QUERY'], objective: 'Open Umami and capture browser-session context for an API query.' },
  umami_create_share_url: { platform: 'umami', risk: 'admin', url: `${UMAMI_BASE}/settings/websites`, required: ['WEBSITE_ID'], objective: 'Create or copy an Umami share URL.' },
  umami_manage_user_access: { platform: 'umami', risk: 'admin', url: `${UMAMI_BASE}/settings`, required: ['WEBSITE_ID', 'USER_EMAIL', 'ROLE'], objective: 'Manage Umami user access.' },
  umami_export_report: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Export or capture an Umami report.' },

  googleanalytics_login: { platform: 'googleanalytics', risk: 'verify', url: GA_BASE, required: [], objective: 'Verify the Google Analytics browser session is authenticated.' },
  googleanalytics_find_property: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['DOMAIN_OR_NAME'], objective: 'Find a GA4 property.' },
  googleanalytics_create_account: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['ACCOUNT_NAME'], objective: 'Create a Google Analytics account container.' },
  googleanalytics_create_property: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_NAME', 'TIMEZONE', 'CURRENCY'], objective: 'Create a GA4 property.' },
  googleanalytics_create_web_stream: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'SITE_URL', 'STREAM_NAME'], objective: 'Create a GA4 web data stream.' },
  googleanalytics_get_measurement_id: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID'], objective: 'Read the GA4 measurement id.' },
  googleanalytics_get_global_site_tag: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'STREAM_ID'], objective: 'Read the Google tag snippet.' },
  googleanalytics_create_measurement_protocol_secret: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'STREAM_ID', 'NICKNAME'], objective: 'Create a Measurement Protocol API secret.' },
  googleanalytics_install_gtag: { platform: 'googleanalytics', risk: 'verify', url: () => input('SITE_URL', 'https://www.needher.ai'), required: ['SITE_URL', 'MEASUREMENT_ID'], objective: 'Verify a target app serves the GA4 tag.' },
  googleanalytics_verify_realtime: { platform: 'googleanalytics', risk: 'verify', url: GA_BASE, required: ['SITE_URL', 'MEASUREMENT_ID'], objective: 'Verify GA4 realtime tracking.' },
  googleanalytics_view_debugview: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DEBUG_DEVICE_OR_EVENT'], objective: 'Open GA4 DebugView.' },
  googleanalytics_view_realtime: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID'], objective: 'Open GA4 realtime analytics.' },
  googleanalytics_run_data_api_report: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DIMENSIONS', 'METRICS', 'DATE_RANGE'], objective: 'Run or stage a GA4 report by dimensions and metrics.' },
  googleanalytics_view_acquisition: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DATE_RANGE'], objective: 'Read GA4 acquisition reports.' },
  googleanalytics_view_engagement: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DATE_RANGE'], objective: 'Read GA4 engagement reports.' },
  googleanalytics_view_pages: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DATE_RANGE'], objective: 'Read GA4 pages and screens.' },
  googleanalytics_create_key_event: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'EVENT_NAME'], objective: 'Create or mark a GA4 key event.' },
  googleanalytics_view_key_events: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DATE_RANGE'], objective: 'Read GA4 key events.' },
  googleanalytics_create_audience: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'AUDIENCE_DEFINITION'], objective: 'Create a GA4 audience.' },
  googleanalytics_create_custom_dimension: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'DIMENSION_NAME', 'SCOPE', 'PARAMETER_NAME'], objective: 'Create a GA4 custom dimension.' },
  googleanalytics_create_custom_metric: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'METRIC_NAME', 'PARAMETER_NAME', 'UNIT'], objective: 'Create a GA4 custom metric.' },
  googleanalytics_link_search_console: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'SEARCH_CONSOLE_PROPERTY'], objective: 'Link Search Console to GA4.' },
  googleanalytics_link_google_ads: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'GOOGLE_ADS_CUSTOMER_ID'], objective: 'Link Google Ads to GA4.' },
  googleanalytics_update_data_retention: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'RETENTION_DURATION'], objective: 'Read or update GA4 retention settings.' },
  googleanalytics_add_user: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'USER_EMAIL', 'ROLE'], objective: 'Grant a user GA access.' },
  googleanalytics_export_report: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'REPORT_NAME', 'DATE_RANGE'], objective: 'Export or capture a GA4 report.' },
};

function input(name, fallback = '') {
  return process.env[name] || fallback;
}

function actionName() {
  if (process.env.SERVICE_ACTION) return process.env.SERVICE_ACTION;
  if (process.env.ACTION) return process.env.ACTION;
  if (process.env.PLATFORM && process.env.VERB) return `${process.env.PLATFORM}_${process.env.VERB}`;
  return '';
}

function actionUrl(cfg) {
  return typeof cfg.url === 'function' ? cfg.url() : cfg.url;
}

function missingInputs(cfg) {
  return cfg.required.filter((key) => !process.env[key]);
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function waitRendered(page, minLength = 80) {
  for (let i = 0; i < 30; i++) {
    const text = await bodyText(page);
    if (text.length >= minLength) return text;
    await humanIdlePause('short');
  }
  return bodyText(page);
}

async function clickFirst(page, candidates) {
  for (const name of candidates) {
    const loc = page.getByRole('button', { name }).or(page.getByRole('link', { name })).or(page.getByText(name)).filter({ visible: true }).first();
    if (await loc.isVisible().catch(() => false)) {
      await humanClickLocator(page, loc, { timeoutMs: 10000 }).catch(() => {});
      await humanIdlePause('deliberate');
      return true;
    }
  }
  return false;
}

async function fillAny(page, value, labelPatterns) {
  if (!value) return false;
  for (const pattern of labelPatterns) {
    const byLabel = page.getByLabel(pattern).filter({ visible: true }).first();
    if (await byLabel.isVisible().catch(() => false)) {
      await humanFill(page, byLabel, value);
      return true;
    }
    const byPlaceholder = page.getByPlaceholder(pattern).filter({ visible: true }).first();
    if (await byPlaceholder.isVisible().catch(() => false)) {
      await humanFill(page, byPlaceholder, value);
      return true;
    }
  }
  const inputBox = page.locator('input:not([type="hidden"]), textarea').filter({ visible: true }).first();
  if (await inputBox.isVisible().catch(() => false)) {
    await humanFill(page, inputBox, value);
    return true;
  }
  return false;
}

async function umamiLogin(s) {
  await s.goto(UMAMI_BASE);
  await humanIdlePause('deliberate');
  if (!/login|signin/i.test(s.page.url()) && !await s.page.locator('input[type="password"]').first().isVisible().catch(() => false)) return true;
  const login = await getServiceLogin('Umami') ?? (
    process.env.UMAMI_EMAIL && process.env.UMAMI_PASSWORD
      ? { email: process.env.UMAMI_EMAIL, password: process.env.UMAMI_PASSWORD, loginMethod: 'email_password' }
      : null
  );
  if (!login) throw new Error('no Umami credentials: set service_credentials display_name=Umami or UMAMI_EMAIL/UMAMI_PASSWORD');
  await fillAny(s.page, login.email, [/email/i, /user/i]);
  await fillAny(s.page, login.password, [/password/i]);
  await clickFirst(s.page, [/log in/i, /login/i, /sign in/i, /continue/i]);
  for (let i = 0; i < 40; i++) {
    await humanIdlePause('short');
    if (!/login|signin/i.test(s.page.url())) return true;
  }
  throw new Error(`Umami login did not leave login page: ${s.page.url()}`);
}

async function clickGoogleAccountIfVisible(page, email) {
  if (!email) return false;
  const tile = page.locator(`div[data-identifier="${email}"], [data-email="${email}"]`)
    .or(page.getByText(email, { exact: true })).filter({ visible: true }).first();
  if (await tile.isVisible().catch(() => false)) {
    await humanClickLocator(page, tile, { timeoutMs: 10000 }).catch(() => {});
    await humanIdlePause('long');
    return true;
  }
  return false;
}

async function googleAnalyticsLogin(s) {
  await s.goto(GA_BASE);
  await humanIdlePause('deliberate');
  let creds = await getServiceLogin('Google Analytics') ?? await getGoogleSsoCreds();
  if (!/accounts\.google\.com|ServiceLogin|signin/i.test(s.page.url())) {
    const signIn = s.page.getByRole('link', { name: /sign in/i }).or(s.page.getByRole('button', { name: /sign in/i })).first();
    if (await signIn.isVisible().catch(() => false)) {
      await humanClickLocator(s.page, signIn, { timeoutMs: 10000 }).catch(() => {});
      await humanIdlePause('long');
    }
  }
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(s.page.url())) {
    if (!creds) throw new Error('no Google Analytics credentials: set service_credentials display_name=Google Analytics or shared Google SSO credentials');
    await clickGoogleAccountIfVisible(s.page, creds.email);
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(s.page.url())) {
      const ok = await googleSso(s, creds, { originHost: 'analytics.google.com' });
      if (!ok) throw new Error('Google Analytics SSO did not complete');
    }
  }
  for (let i = 0; i < 40; i++) {
    await humanIdlePause('short');
    if (/analytics\.google\.com/.test(s.page.url()) && !/accounts\.google\.com|signin/i.test(s.page.url())) return true;
  }
  return /analytics\.google\.com/.test(s.page.url());
}

async function ensureLoggedIn(s, cfg) {
  if (cfg.platform === 'umami') return umamiLogin(s);
  return googleAnalyticsLogin(s);
}

function propertyRoute(section = 'reports') {
  const propertyId = input('PROPERTY_ID');
  if (!propertyId) return GA_BASE;
  return `${GA_BASE}#/p${propertyId}/${section}`;
}

function resolvedUrl(cfg) {
  const action = actionName();
  if (cfg.platform === 'googleanalytics') {
    if (action.includes('realtime')) return propertyRoute('realtime');
    if (action.includes('debugview')) return propertyRoute('admin/debugview');
    if (action.includes('acquisition')) return propertyRoute('reports/acquisition');
    if (action.includes('engagement')) return propertyRoute('reports/engagement');
    if (action.includes('pages')) return propertyRoute('reports/engagement/pages-and-screens');
    if (action.includes('key_event')) return propertyRoute('admin/events/key-events');
    if (action.includes('audience')) return propertyRoute('admin/audiences');
    if (action.includes('custom_dimension') || action.includes('custom_metric')) return propertyRoute('admin/custom-definitions');
    if (action.includes('data_retention')) return propertyRoute('admin/data-retention');
    return actionUrl(cfg);
  }
  return actionUrl(cfg);
}

async function openExpectedDashboardSection(s) {
  const action = actionName();
  if (action === 'googleanalytics_view_realtime' || action === 'googleanalytics_verify_realtime') {
    await clickFirst(s.page, [/^View real time$/i, /^Realtime$/i, /^Real-time$/i]);
    await humanIdlePause('long');
  }
}

async function prepareWrite(s, cfg) {
  if (WRITE_CONFIRM) return false;
  const dir = runRecordingsDir(actionName());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pending_review.json'), JSON.stringify({
    action: actionName(),
    platform: cfg.platform,
    risk: cfg.risk,
    objective: cfg.objective,
    required: cfg.required,
    inputs: Object.fromEntries(cfg.required.map((key) => [key, process.env[key] ?? null])),
    reason: 'WRITE_CONFIRM=1 required before Weles performs admin/write browser changes',
  }, null, 2));
  return true;
}

async function performConfirmedWrite(s, cfg) {
  const action = actionName();
  if (cfg.platform === 'umami' && action === 'umami_create_website') {
    await clickFirst(s.page, [/add website/i, /create website/i, /new website/i, /add/i]);
    await fillAny(s.page, input('DISPLAY_NAME'), [/name/i, /website name/i]);
    await fillAny(s.page, input('DOMAIN'), [/domain/i]);
    await clickFirst(s.page, [/save/i, /create/i, /add/i]);
    return;
  }
  if (cfg.platform === 'umami' && action === 'umami_update_website_settings') {
    await clickFirst(s.page, [/settings/i, /edit/i]);
    const patch = input('SETTINGS_PATCH');
    if (patch) await fillAny(s.page, patch, [/name/i, /domain/i, /timezone/i]);
    await clickFirst(s.page, [/save/i, /update/i]);
    return;
  }
  if (cfg.platform === 'googleanalytics') {
    await clickFirst(s.page, [/admin/i, /create/i, /new/i, /add/i]);
    await fillAny(s.page, input('ACCOUNT_NAME') || input('PROPERTY_NAME') || input('STREAM_NAME') || input('EVENT_NAME') || input('USER_EMAIL') || input('DIMENSION_NAME') || input('METRIC_NAME') || input('NICKNAME'), [/name/i, /email/i, /event/i, /stream/i, /property/i, /nickname/i]);
    await fillAny(s.page, input('SITE_URL'), [/url/i, /website/i]);
    await fillAny(s.page, input('ROLE'), [/role/i]);
    await clickFirst(s.page, [/save/i, /create/i, /submit/i, /add/i, /next/i]);
    return;
  }
  await clickFirst(s.page, [/create/i, /save/i, /add/i, /update/i]);
}

async function verifyTargetSite(s, cfg) {
  const action = actionName();
  await s.goto(input('SITE_URL', 'https://www.needher.ai'));
  await humanIdlePause('long');
  if (action === 'umami_track_custom_event' && process.env.SELECTOR_OR_CODE_PATH) {
    const target = s.page.locator(process.env.SELECTOR_OR_CODE_PATH).first();
    await humanClickLocator(s.page, target, { timeoutMs: 10000 }).catch(() => {});
    await humanIdlePause('deliberate');
  }
  const data = await s.page.evaluate(() => ({
    url: location.href,
    title: document.title,
    scripts: Array.from(document.scripts).map((script) => ({
      src: script.src,
      websiteId: script.getAttribute('data-website-id'),
    })),
    bodyText: document.body?.innerText?.slice(0, 3000) ?? '',
  }));
  const text = JSON.stringify(data);
  if (action === 'umami_verify_tracking_script' && !text.includes(input('WEBSITE_ID'))) {
    throw new Error(`Umami website id ${input('WEBSITE_ID')} not found on target site`);
  }
  if (action === 'umami_track_custom_event' && !/umami/i.test(text)) {
    throw new Error('Umami tracking script not found on target site; custom event cannot be tracked');
  }
  if ((action === 'googleanalytics_install_gtag' || action === 'googleanalytics_verify_realtime') && !text.includes(input('MEASUREMENT_ID'))) {
    throw new Error(`GA measurement id ${input('MEASUREMENT_ID')} not found on target site`);
  }
  return data;
}

async function captureEvidence(s, cfg, extra = {}) {
  const dir = runRecordingsDir(actionName());
  mkdirSync(dir, { recursive: true });
  const text = await waitRendered(s.page);
  const evidence = {
    action: actionName(),
    platform: cfg.platform,
    risk: cfg.risk,
    objective: cfg.objective,
    url: s.page.url(),
    title: await s.page.title().catch(() => ''),
    required: cfg.required,
    inputs: Object.fromEntries(cfg.required.map((key) => [key, process.env[key] ?? null])),
    bodyText: text.slice(0, 12000),
    capturedRequests: s.capturedResponses.slice(-50).map((r) => ({ method: r.method, url: r.url, status: r.status })),
    ...extra,
  };
  writeFileSync(join(dir, 'service_action_result.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(join(dir, 'dashboard-text.txt'), text);
  try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); } catch {}
  try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
  return evidence;
}

function assertExpectedEvidence(evidence) {
  const action = actionName();
  const text = evidence.bodyText || '';
  if ((action === 'googleanalytics_view_realtime' || action === 'googleanalytics_verify_realtime')
    && !/realtime|real time/i.test(evidence.url)
    && !/realtime overview/i.test(text)) {
    throw new Error(`GA realtime view did not open; final_url=${evidence.url}`);
  }
  if (action === 'googleanalytics_get_measurement_id' && !/Measurement ID:G-[A-Z0-9]+/i.test(text)) {
    throw new Error('GA measurement id was not visible in the captured page');
  }
  if (action === 'googleanalytics_get_global_site_tag' && !/gtag\(|googletagmanager\.com\/gtag\/js|Google tag/i.test(text)) {
    throw new Error('GA global site tag snippet was not visible in the captured page');
  }
  if (action === 'googleanalytics_view_debugview' && !/debugview/i.test(evidence.url)) {
    throw new Error(`GA DebugView did not open; final_url=${evidence.url}`);
  }
  const expectedSections = {
    googleanalytics_view_acquisition: /Acquisition/i,
    googleanalytics_view_engagement: /Engagement/i,
    googleanalytics_view_pages: /Pages and screens|Page title and screen name/i,
    googleanalytics_view_key_events: /Key events/i,
  };
  const sectionPattern = expectedSections[action];
  if (sectionPattern && (evidence.url.includes('/reports/intelligenthome') || !sectionPattern.test(text))) {
    throw new Error(`${action} did not open the expected GA section; final_url=${evidence.url}`);
  }
}

function writeBanSignal(signal, healthy, details = {}) {
  const dir = runRecordingsDir(actionName());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({
    action: actionName(),
    signal,
    healthy,
    details,
    ts: new Date().toISOString(),
  }, null, 2));
}

async function run() {
  const name = actionName();
  const cfg = ACTIONS[name];
  if (!cfg) throw new Error(`unsupported analytics service action: ${name}`);

  const missing = missingInputs(cfg);
  if (missing.length) throw new Error(`missing required input(s): ${missing.join(', ')}`);

  const s = await WSession.start({ label: name, browser: 'chromium', proxy: process.env.PROXY_URL || 'direct', os: 'macos' });
  const store = new SessionStore();
  try {
    await store.injectPlaywright?.(s.ctx, cfg.platform).catch(() => {});
    if (!name.includes('verify_tracking_script') && !name.includes('track_custom_event') && !name.includes('install_gtag')) {
      await ensureLoggedIn(s, cfg);
      await store.capturePlaywright?.(s.ctx, cfg.platform).catch(() => {});
    }

    const pending = (cfg.risk === 'write' || cfg.risk === 'admin') && await prepareWrite(s, cfg);
    if (pending) {
      await s.goto(resolvedUrl(cfg));
      await captureEvidence(s, cfg, { pending_review: true });
      writeBanSignal('pending_review', true, { risk: cfg.risk, reason: 'write/admin action staged for approval' });
      console.log(`PASS: ${name} pending_review`);
      return;
    }

    let extra = {};
    if (name === 'googleanalytics_verify_realtime') {
      extra.targetSite = await verifyTargetSite(s, cfg);
      await s.goto(resolvedUrl(cfg));
      await humanIdlePause('long');
      await openExpectedDashboardSection(s);
    } else if (name.includes('verify_tracking_script') || name === 'umami_track_custom_event' || name === 'googleanalytics_install_gtag') {
      extra.targetSite = await verifyTargetSite(s, cfg);
    } else {
      await s.goto(resolvedUrl(cfg));
      await humanIdlePause('long');
      if (cfg.platform === 'googleanalytics') await openExpectedDashboardSection(s);
      for (let i = 0; i < 2; i++) await humanScroll(s.page, 800, 2).catch(() => {});
      if (cfg.risk === 'write' || cfg.risk === 'admin') await performConfirmedWrite(s, cfg);
    }

    const evidence = await captureEvidence(s, cfg, extra);
    assertExpectedEvidence(evidence);
    writeBanSignal('healthy', true, { final_url: evidence.url, evidence_file: 'service_action_result.json' });
    console.log(`PASS: ${name} ${cfg.objective}`);
  } finally {
    await s.close().catch(() => {});
  }
}

run().catch((e) => {
  writeBanSignal('service_action_failed', false, { reason: e.message?.slice(0, 300) ?? String(e) });
  console.log('FAIL:', e.message?.slice(0, 300));
  process.exit(1);
});
