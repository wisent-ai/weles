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
const UMAMI_APP_BASE = `${UMAMI_BASE}/analytics/us`;
const GA_BASE = 'https://analytics.google.com/analytics/web/';
const WRITE_CONFIRM = process.env.WRITE_CONFIRM === '1';

const ACTIONS = {
  umami_register: { platform: 'umami', risk: 'admin', url: `${UMAMI_BASE}/signup`, required: ['EMAIL', 'PASSWORD'], objective: 'Register a new Umami Cloud account.' },
  umami_login: { platform: 'umami', risk: 'verify', url: UMAMI_BASE, required: [], objective: 'Verify the Umami browser session is authenticated.' },
  umami_create_website: { platform: 'umami', risk: 'write', url: `${UMAMI_APP_BASE}/websites`, required: ['DOMAIN', 'DISPLAY_NAME'], objective: 'Create an Umami website entry.' },
  umami_find_website: { platform: 'umami', risk: 'read', url: `${UMAMI_APP_BASE}/websites`, required: ['DOMAIN_OR_NAME'], objective: 'Find an Umami website row by domain or name.' },
  umami_get_website_id: { platform: 'umami', risk: 'read', url: `${UMAMI_APP_BASE}/websites`, required: ['DOMAIN_OR_NAME'], objective: 'Read the Umami website id.' },
  umami_get_tracking_snippet: { platform: 'umami', risk: 'read', url: `${UMAMI_BASE}/settings/websites`, required: ['WEBSITE_ID'], objective: 'Read the Umami tracking snippet.' },
  umami_update_website_settings: { platform: 'umami', risk: 'write', url: `${UMAMI_APP_BASE}/websites`, required: ['WEBSITE_ID', 'SETTINGS_PATCH'], objective: 'Update Umami website settings.' },
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
  umami_create_share_url: { platform: 'umami', risk: 'admin', url: `${UMAMI_APP_BASE}/websites`, required: ['WEBSITE_ID'], objective: 'Create or copy an Umami share URL.' },
  umami_manage_user_access: { platform: 'umami', risk: 'admin', url: `${UMAMI_BASE}/settings`, required: ['WEBSITE_ID', 'USER_EMAIL', 'ROLE'], objective: 'Manage Umami user access.' },
  umami_export_report: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Export or capture an Umami report.' },

  googleanalytics_register: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['ACCOUNT_NAME', 'PROPERTY_NAME', 'SITE_URL', 'STREAM_NAME'], objective: 'Create a GA4 account, property, and web stream from scratch.' },
  googleanalytics_register_needher: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: [], objective: 'Create the NeedHer GA4 account, property, and web stream from scratch.' },
  googleanalytics_login: { platform: 'googleanalytics', risk: 'verify', url: GA_BASE, required: [], objective: 'Verify the Google Analytics browser session is authenticated.' },
  googleanalytics_find_property: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['DOMAIN_OR_NAME'], objective: 'Find a GA4 property.' },
  googleanalytics_create_account: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['ACCOUNT_NAME'], objective: 'Create a Google Analytics account container.' },
  googleanalytics_create_property: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_NAME', 'TIMEZONE', 'CURRENCY'], objective: 'Create a GA4 property.' },
  googleanalytics_create_web_stream: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'SITE_URL', 'STREAM_NAME'], objective: 'Create a GA4 web data stream.' },
  googleanalytics_get_measurement_id: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID'], objective: 'Read the GA4 measurement id.' },
  googleanalytics_get_global_site_tag: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID'], objective: 'Read the Google tag snippet.' },
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

function defaultInput(name, fallback) {
  const value = input(name);
  return value || fallback;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function siteHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

function siteHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function extractGaMeasurementId(text) {
  return text.match(/\bG-[A-Z0-9]+\b/)?.[0] ?? null;
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

async function safeGoto(s, url) {
  try {
    await s.goto(url);
  } catch (e) {
    const message = e.message ?? '';
    if (/ERR_ABORTED|interrupted by another navigation/i.test(message)) {
      await humanIdlePause('short').catch(() => {});
    }
    const current = s.page.url();
    const target = String(url).replace(/\/$/, '');
    if (/ERR_ABORTED|interrupted by another navigation/i.test(message) && current.replace(/\/$/, '').startsWith(target)) return;
    if (/ERR_ABORTED|interrupted by another navigation/i.test(message)) {
      const currentUrl = new URL(current);
      const targetUrl = new URL(url);
      if (targetUrl.hostname === 'cloud.umami.is' && currentUrl.hostname === targetUrl.hostname && !/login|signin/i.test(current)) return;
    }
    throw e;
  }
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
      try {
        await humanClickLocator(page, loc, { timeoutMs: 10000 });
        await humanIdlePause('deliberate');
        return true;
      } catch {}
    }
  }
  return false;
}

async function clickCardLike(page, name) {
  const loc = page.locator('a, button, tr, mat-row, [role="row"], [role="button"], [role="link"], mat-card, .card, .admin-card, .admin-settings-card')
    .filter({ hasText: name })
    .filter({ visible: true })
    .first();
  if (await loc.isVisible().catch(() => false)) {
    try {
      await humanClickLocator(page, loc, { timeoutMs: 10000 });
      await humanIdlePause('deliberate');
      return true;
    } catch {}
  }
  return false;
}

async function clickLocator(page, loc, timeoutMs = 10000) {
  if (!await loc.isVisible().catch(() => false)) return false;
  try {
    await humanClickLocator(page, loc, { timeoutMs });
  } catch {
    try {
      await loc.click({ timeout: timeoutMs });
    } catch {
      return false;
    }
  }
  await humanIdlePause('deliberate');
  return true;
}

async function clickDirectLocator(page, loc, timeoutMs = 10000) {
  const target = loc.filter({ visible: true }).first();
  if (!await target.isVisible().catch(() => false)) return false;
  const disabled = await target.evaluate((node) => (
    node.hasAttribute('disabled')
    || node.getAttribute('aria-disabled') === 'true'
    || node.classList.contains('mat-mdc-button-disabled')
    || node.classList.contains('mat-button-disabled')
  )).catch(() => false);
  if (disabled) return false;
  await target.scrollIntoViewIfNeeded({ timeout: Math.min(timeoutMs, 5000) }).catch(() => {});
  try {
    await target.click({ timeout: timeoutMs });
  } catch {
    await target.click({ timeout: timeoutMs, force: true });
  }
  await humanIdlePause('deliberate');
  return true;
}

async function clickAnyLocator(page, locators, description = '') {
  for (const loc of locators) {
    if (await clickDirectLocator(page, loc).catch(() => false)) return true;
  }
  if (description) throw new Error(`${description} was not clickable`);
  return false;
}

async function clickDomElement(page, selectors, textPattern = null) {
  const pattern = textPattern ? { source: textPattern.source, flags: textPattern.flags } : null;
  const clicked = await page.evaluate(({ selectors: selectorList, pattern: patternSpec }) => {
    const matcher = patternSpec ? new RegExp(patternSpec.source, patternSpec.flags) : null;
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && box.width > 0
        && box.height > 0
        && !node.hasAttribute('disabled')
        && node.getAttribute('aria-disabled') !== 'true'
        && !node.classList.contains('mat-mdc-button-disabled')
        && !node.classList.contains('mat-button-disabled');
    };
    const nodes = selectorList.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const target = nodes.find((node) => {
      if (!visible(node)) return false;
      if (!matcher) return true;
      const label = `${node.textContent || ''} ${node.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim();
      return matcher.test(label);
    });
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    target.click();
    return true;
  }, { selectors, pattern }).catch(() => false);
  if (clicked) await humanIdlePause('deliberate');
  return clicked;
}

async function fillDomInput(page, selectors, value) {
  if (!value) return false;
  const filled = await page.evaluate(({ selectors: selectorList, value: inputValue }) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && box.width > 0
        && box.height > 0
        && !node.hasAttribute('disabled')
        && node.getAttribute('aria-disabled') !== 'true';
    };
    const field = selectorList
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .find((node) => visible(node));
    if (!field) return false;
    field.scrollIntoView({ block: 'center', inline: 'center' });
    field.focus();
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) descriptor.set.call(field, inputValue);
    else field.value = inputValue;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: inputValue }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    return true;
  }, { selectors, value }).catch(() => false);
  if (filled) await humanIdlePause('short');
  return filled;
}

async function openDataStreamDetail(s) {
  if (!/\/admin\/streams\/table/.test(s.page.url())) return false;
  const streamId = input('STREAM_ID');
  const streamName = input('STREAM_NAME');
  const candidates = [];
  if (streamId && streamId !== 'unknown-stream') candidates.push(new RegExp(streamId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (streamName) candidates.push(new RegExp(`^${streamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
  candidates.push(/\b\d{6,}\b/);
  for (const candidate of candidates) {
    if (await clickFirst(s.page, [candidate])) return true;
    if (await clickCardLike(s.page, candidate)) return true;
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

async function fillWithin(scope, page, value, labelPatterns) {
  if (!value) return false;
  for (const pattern of labelPatterns) {
    const byLabel = scope.getByLabel(pattern).filter({ visible: true }).first();
    if (await byLabel.isVisible().catch(() => false)) {
      await humanFill(page, byLabel, value);
      return true;
    }
    const byPlaceholder = scope.getByPlaceholder(pattern).filter({ visible: true }).first();
    if (await byPlaceholder.isVisible().catch(() => false)) {
      await humanFill(page, byPlaceholder, value);
      return true;
    }
  }
  return false;
}

async function fillWithinOrNth(scope, page, value, labelPatterns, index) {
  if (await fillWithin(scope, page, value, labelPatterns)) return true;
  const field = scope.locator('input:not([type="hidden"]), textarea').filter({ visible: true }).nth(index);
  if (await field.isVisible().catch(() => false)) {
    await humanFill(page, field, value);
    return true;
  }
  return false;
}

async function clickRequired(page, candidates, description) {
  if (await clickFirst(page, candidates)) return;
  throw new Error(`${description} was not clickable`);
}

function activeStepPanel(page) {
  return page
    .locator('div[role="tabpanel"]:not([inert]):not([aria-hidden="true"])')
    .filter({ visible: true })
    .first();
}

async function selectedGaStep(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    };
    const labels = Array.from(document.querySelectorAll('.mat-step-header[aria-selected="true"] .mat-step-text-label'));
    return labels.find((node) => visible(node))?.textContent?.replace(/\s+/g, ' ').trim() || '';
  }).catch(() => '');
}

async function waitForGaStep(page, pattern, description) {
  for (let i = 0; i < 50; i++) {
    const step = await selectedGaStep(page);
    if (pattern.test(step)) return;
    await humanIdlePause('short');
  }
  const step = await selectedGaStep(page);
  throw new Error(`${description} did not advance; selected_step=${JSON.stringify(step)}`);
}

async function waitForGaStepOrText(page, stepPattern, textPattern, description) {
  for (let i = 0; i < 50; i++) {
    const step = await selectedGaStep(page);
    const text = await bodyText(page);
    if (stepPattern.test(step) || textPattern.test(text)) return;
    await humanIdlePause('short');
  }
  const step = await selectedGaStep(page);
  const text = await bodyText(page);
  throw new Error(`${description} did not advance; selected_step=${JSON.stringify(step)}; body_preview=${text.slice(0, 500).replace(/\s+/g, ' ')}`);
}

function enabledButtonLocator(root, pattern) {
  return root
    .getByRole('button', { name: pattern })
    .or(root.locator('button, material-button, [role="button"], a[role="button"]').filter({ hasText: pattern }))
    .filter({ visible: true })
    .filter({ hasNot: root.locator('[disabled], [aria-disabled="true"]') });
}

async function visibleFormScope(page) {
  const panel = activeStepPanel(page);
  if (await panel.isVisible().catch(() => false)) return panel;
  return page
    .getByRole('dialog')
    .or(page.locator('form, main, ga-admin-root, [role="main"], body'))
    .filter({ visible: true })
    .first();
}

async function dismissGoogleAnalyticsOverlays(page) {
  for (const selector of [
    'button[aria-label*="Close"]',
    '[role="button"][aria-label*="Close"]',
    'material-button.close',
    'button.close',
    '.close-button',
  ]) {
    await clickAnyLocator(page, [page.locator(selector)]).catch(() => false);
  }
  for (const labels of [
    [/^Close$/i, /Got it/i, /Dismiss/i],
    [/^Skip$/i, /No thanks/i, /Maybe later/i],
  ]) {
    await clickFirst(page, labels).catch(() => false);
  }
}

async function clickGaNext(page, description = 'GA wizard next button', expectedStepPattern = null) {
  await dismissGoogleAnalyticsOverlays(page);
  const pattern = /^(Next|Continue|Save|Create|Create and continue|Submit|I accept|Accept)$/i;
  const panel = activeStepPanel(page);
  const locators = [];
  if (await panel.isVisible().catch(() => false)) locators.push(enabledButtonLocator(panel, pattern));
  locators.push(enabledButtonLocator(page, pattern));
  if (!await clickAnyLocator(page, locators).catch(() => false)) {
    if (!await clickFirst(page, [/^Next$/i, /^Continue$/i, /^Save$/i, /^Create$/i, /^Create and continue$/i, /^Submit$/i, /^I accept$/i, /^Accept$/i]).catch(() => false)) {
      const text = await bodyText(page);
      const buttons = await page.locator('button, material-button, [role="button"], a[role="button"]')
        .filter({ visible: true })
        .evaluateAll((nodes) => nodes.map((node) => ({
          text: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          disabled: node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true',
        })).filter((item) => item.text).slice(-20))
        .catch(() => []);
      throw new Error(`${description} was not clickable; visible_buttons=${JSON.stringify(buttons)}; body_preview=${text.slice(0, 500).replace(/\s+/g, ' ')}`);
    }
  }
  if (expectedStepPattern) {
    await waitForGaStep(page, expectedStepPattern, description);
    return;
  }
  await waitRendered(page, 40).catch(() => '');
}

async function selectVisibleChoice(page, candidates) {
  for (const candidate of candidates) {
    if (await clickFirst(page, [candidate]).catch(() => false)) return true;
  }
  const controls = page.locator('mat-radio-button, mat-checkbox, [role="radio"], [role="checkbox"], label, button').filter({ visible: true });
  const count = await controls.count().catch(() => 0);
  if (count > 0) {
    await clickLocator(page, controls.nth(0)).catch(() => false);
    return true;
  }
  return false;
}

async function setOptionalDropdown(page, labelPatterns, value) {
  if (!value) return false;
  for (const pattern of labelPatterns) {
    const control = page.getByLabel(pattern)
      .or(page.locator('mat-select, [role="combobox"], input').filter({ hasText: pattern }))
      .filter({ visible: true })
      .first();
    if (!await control.isVisible().catch(() => false)) continue;
    await clickLocator(page, control).catch(() => false);
    await humanIdlePause('short');
    const search = page.locator('input:not([type="hidden"])').filter({ visible: true }).last();
    if (await search.isVisible().catch(() => false)) {
      await humanFill(page, search, value).catch(() => {});
      await humanIdlePause('short');
    }
    if (await clickDomElement(page, [
      '.cdk-overlay-container [debug-id="option-item"]',
      '.cdk-overlay-container [role="option"]',
      '.cdk-overlay-container mat-option',
      '.cdk-overlay-container button',
    ], new RegExp(escapeRegExp(value), 'i')).catch(() => false)) return true;
    await page.keyboard.press('Escape').catch(() => {});
  }
  return false;
}

async function setGoogleAnalyticsIndustry(page) {
  const business = page.locator('ga-business-info').filter({ visible: true }).first();
  const trigger = business
    .locator('industry-selector button[debug-id="menu-open-button"], searchable-select[required] button[debug-id="menu-open-button"]')
    .filter({ visible: true })
    .first();
  if (!await clickDirectLocator(page, trigger).catch(() => false)) return false;
  await humanIdlePause('short');

  const search = page.locator('.cdk-overlay-container input:not([type="hidden"]), .cdk-overlay-container textarea')
    .filter({ visible: true })
    .first();
  if (await search.isVisible().catch(() => false)) {
    await humanFill(page, search, defaultInput('INDUSTRY_CATEGORY', 'Other')).catch(() => {});
    await humanIdlePause('short');
  }

  const preferred = new RegExp(`^${escapeRegExp(defaultInput('INDUSTRY_CATEGORY', 'Other'))}$`, 'i');
  return await clickDomElement(page, [
    '.cdk-overlay-container [debug-id="option-item"]',
    '.cdk-overlay-container [role="menuitem"]',
    '.cdk-overlay-container [role="option"]',
    '.cdk-overlay-container button',
  ], preferred).catch(() => false)
    || await clickDomElement(page, [
      '.cdk-overlay-container [debug-id="option-item"]',
      '.cdk-overlay-container [role="menuitem"]',
      '.cdk-overlay-container [role="option"]',
      '.cdk-overlay-container button',
    ], /Other|Internet|Online|Technology|Community|Consumer/i).catch(() => false);
}

async function setGoogleAnalyticsBusinessSize(page) {
  const business = page.locator('ga-business-info').filter({ visible: true }).first();
  const value = defaultInput('BUSINESS_SIZE', '1');
  const input = business.locator(`input[type="radio"][value="${escapeRegExp(value)}"]`).first();
  if (await input.count().catch(() => 0)) {
    await input.check({ force: true, timeout: 5000 }).catch(() => {});
    await humanIdlePause('short');
    if (await input.isChecked().catch(() => false)) return true;
  }
  return clickAnyLocator(page, [
    business.locator('label').filter({ hasText: /Small|1 to 10/i }),
    business.locator('mat-radio-button').filter({ hasText: /Small|1 to 10/i }),
    business.locator('label').filter({ hasText: /Medium|11 to 100/i }),
    business.locator('mat-radio-button').filter({ hasText: /Medium|11 to 100/i }),
  ]).catch(() => false);
}

async function setGoogleAnalyticsObjective(page) {
  const panel = activeStepPanel(page);
  const objective = defaultInput('BUSINESS_OBJECTIVE', 'Understand web and/or app traffic');
  const preferred = panel.locator(`input[type="checkbox"][name*="${objective.replace(/"/g, '\\"')}"]`).first();
  if (await preferred.count().catch(() => 0)) {
    await preferred.check({ force: true, timeout: 5000 }).catch(() => {});
    await humanIdlePause('short');
    if (await preferred.isChecked().catch(() => false)) return true;
  }
  const fallback = panel.locator('input[type="checkbox"][name*="Understand web"], input[type="checkbox"][name*="Other business"]').first();
  if (await fallback.count().catch(() => 0)) {
    await fallback.check({ force: true, timeout: 5000 }).catch(() => {});
    await humanIdlePause('short');
    if (await fallback.isChecked().catch(() => false)) return true;
  }
  return clickAnyLocator(page, [
    panel.locator('slat').filter({ hasText: /Understand web|Other business objectives|View user engagement/i }),
    panel.locator('mat-checkbox').filter({ hasText: /Understand web|Other business objectives|View user engagement/i }),
  ]).catch(() => false);
}

async function clickGoogleAnalyticsCreateButton(page) {
  const panel = activeStepPanel(page);
  for (let i = 0; i < 30; i++) {
    if (await clickAnyLocator(page, [
      panel.locator('button[aria-label="Create an account with a property"], button.create-button'),
      panel.getByRole('button', { name: /^Create$/i }),
      panel.locator('button').filter({ hasText: /^Create$/i }),
    ]).catch(() => false)) return;
    await humanIdlePause('short');
  }
  throw new Error('GA objectives Create button was not enabled');
}

async function umamiRegisterAccount(s) {
  await safeGoto(s, `${UMAMI_BASE}/signup`);
  await humanIdlePause('long');
  if (/404|not found/i.test(await bodyText(s.page))) {
    await safeGoto(s, UMAMI_BASE);
    await clickRequired(s.page, [/sign up/i, /start free/i, /get started/i, /create account/i], 'Umami sign-up entry point');
  }

  const scope = await visibleFormScope(s.page);
  const email = input('EMAIL');
  const password = input('PASSWORD');
  const displayName = defaultInput('DISPLAY_NAME', email.split('@')[0] || 'Weles User');
  const filledName = await fillWithinOrNth(scope, s.page, displayName, [/name/i, /full name/i], 0);
  const filledEmail = await fillWithinOrNth(scope, s.page, email, [/email/i], filledName ? 1 : 0);
  const filledPassword = await fillWithinOrNth(scope, s.page, password, [/password/i], filledName ? 2 : 1);
  if (!filledEmail || !filledPassword) throw new Error('Umami sign-up fields were not fillable');

  await clickRequired(s.page, [/create account/i, /sign up/i, /start free/i, /^continue$/i, /^submit$/i], 'Umami sign-up submit button');
  for (let i = 0; i < 40; i++) {
    const text = await bodyText(s.page);
    if (/verify|verification|check your email|confirm your email|dashboard|websites|account/i.test(text) || !/signup|register/i.test(s.page.url())) {
      return { registration: { email, status: 'submitted_or_verified' } };
    }
    await humanIdlePause('short');
  }
  throw new Error(`Umami sign-up did not reach a verification or account state: ${s.page.url()}`);
}

async function umamiCreateWebsite(s) {
  const addButton = s.page
    .getByRole('button', { name: /^Add website$/i })
    .or(s.page.locator('button').filter({ hasText: /^Add website$/i }))
    .filter({ visible: true })
    .first();
  if (!await addButton.isVisible().catch(() => false)) throw new Error('Umami Add website button was not visible');
  try {
    await addButton.scrollIntoViewIfNeeded({ timeout: 5000 });
    await addButton.click({ timeout: 10000 });
    await humanIdlePause('deliberate');
  } catch {
    if (!await clickLocator(s.page, addButton)) throw new Error('Umami Add website button was not clickable');
  }

  const dialog = s.page.getByRole('dialog').filter({ visible: true }).first();
  for (let i = 0; i < 20 && !await dialog.isVisible().catch(() => false); i++) {
    await humanIdlePause('short');
  }
  if (!await dialog.isVisible().catch(() => false)) {
    await addButton.click({ timeout: 10000, force: true }).catch(() => {});
    await humanIdlePause('deliberate');
    for (let i = 0; i < 20 && !await dialog.isVisible().catch(() => false); i++) {
      await humanIdlePause('short');
    }
  }
  if (!await dialog.isVisible().catch(() => false)) throw new Error('Umami Add website dialog did not open');

  const fields = dialog.locator('input:not([type="hidden"]), textarea').filter({ visible: true });
  let filledName = await fillWithin(dialog, s.page, input('DISPLAY_NAME'), [/^name$/i, /website name/i]);
  if (!filledName && await fields.nth(0).isVisible().catch(() => false)) {
    await humanFill(s.page, fields.nth(0), input('DISPLAY_NAME'));
    filledName = true;
  }
  let filledDomain = await fillWithin(dialog, s.page, input('DOMAIN'), [/^domain$/i, /website domain/i]);
  if (!filledDomain && await fields.nth(1).isVisible().catch(() => false)) {
    await humanFill(s.page, fields.nth(1), input('DOMAIN'));
    filledDomain = true;
  }
  if (!filledName || !filledDomain) throw new Error('Umami Add website dialog fields were not fillable');

  const saveButton = dialog
    .locator('button[data-test="button-submit"], button[type="submit"]')
    .or(dialog.getByRole('button', { name: /^(save|create|add|submit)$/i }))
    .or(dialog.locator('button').filter({ hasText: /^(save|create|add|submit)$/i }))
    .filter({ visible: true })
    .last();
  if (!await saveButton.isVisible().catch(() => false)) throw new Error('Umami Add website save button was not visible');

  const saveResponse = s.page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && /gateway-us\.umami\.is\/api\/.*websites|cloud\.umami\.is\/analytics\/us\/api\/.*websites/i.test(response.url())
  ), { timeout: 15000 }).catch(() => null);
  await saveButton.click({ timeout: 10000 });
  const response = await saveResponse;
  if (response && response.status() >= 400) {
    await humanIdlePause('short');
    const text = await bodyText(s.page);
    const serviceMessage = text.match(/Website limit reached\.?/i)?.[0];
    throw new Error(`Umami Add website save failed: ${serviceMessage ?? `HTTP ${response.status()}`}`);
  }
  await humanIdlePause('long');
  await safeGoto(s, `${UMAMI_APP_BASE}/websites?search=${encodeURIComponent(input('DOMAIN'))}&page=1`);

  const domainPattern = new RegExp(escapeRegExp(input('DOMAIN')), 'i');
  for (let i = 0; i < 30; i++) {
    const text = await bodyText(s.page);
    if (domainPattern.test(text)) return;
    await humanIdlePause('short');
  }
  throw new Error(`Umami website ${input('DOMAIN')} was not visible after save`);
}

function gaRegistrationInputs() {
  const siteUrl = defaultInput('SITE_URL', 'https://www.needher.ai');
  const propertyName = defaultInput('PROPERTY_NAME', 'NeedHer AI');
  return {
    accountName: defaultInput('ACCOUNT_NAME', propertyName),
    propertyName,
    siteUrl,
    streamName: defaultInput('STREAM_NAME', `${propertyName} Web`),
    timezone: defaultInput('TIMEZONE', 'United States'),
    currency: defaultInput('CURRENCY', 'US Dollar'),
    domain: siteHost(siteUrl),
  };
}

async function openGoogleAnalyticsCreateAccount(s) {
  await safeGoto(s, GA_BASE);
  await humanIdlePause('long');
  await dismissGoogleAnalyticsOverlays(s.page);

  const currentHash = new URL(s.page.url()).hash;
  const scope = currentHash.match(/^#\/(a\d+p\d+)\b/)?.[1];
  const adminUrl = scope ? `${GA_BASE}#/${scope}/admin` : `${GA_BASE}#/admin`;
  await safeGoto(s, adminUrl);
  await humanIdlePause('long');
  await dismissGoogleAnalyticsOverlays(s.page);
  for (let i = 0; i < 40; i++) {
    if (await s.page.locator('button[data-guidedhelpid="create-entity-trigger"], .create-entity-menu-trigger').filter({ visible: true }).first().isVisible().catch(() => false)) break;
    if (/\/admin\b/i.test(s.page.url()) && /Account settings|Property settings|Data streams|Create/i.test(await bodyText(s.page))) break;
    await humanIdlePause('short');
  }

  const createButton = [
    s.page.locator('button[data-guidedhelpid="create-entity-trigger"]'),
    s.page.locator('.create-entity-menu-trigger'),
  ];
  if (!await clickDomElement(s.page, ['button[data-guidedhelpid="create-entity-trigger"]', '.create-entity-menu-trigger'], /^Create\b/i)
    && !await clickAnyLocator(s.page, createButton).catch(() => false)) {
    await safeGoto(s, adminUrl);
    await humanIdlePause('long');
    await dismissGoogleAnalyticsOverlays(s.page);
    if (!await clickDomElement(s.page, ['button[data-guidedhelpid="create-entity-trigger"]', '.create-entity-menu-trigger'], /^Create\b/i)) {
      await clickAnyLocator(s.page, createButton, 'GA Admin Create button');
    }
  }
  await humanIdlePause('deliberate');
  if (!await clickDomElement(s.page, [
    '.cdk-overlay-container [role="menuitem"]',
    '.cdk-overlay-container button',
    '.mat-mdc-menu-panel [role="menuitem"]',
    '.mat-mdc-menu-panel button',
    '[role="menuitem"]',
  ], /^(Create account|Account)$/i)) {
    await clickAnyLocator(s.page, [
      s.page.getByRole('menuitem', { name: /^Account$/i }),
      s.page.getByRole('menuitem', { name: /Create account/i }),
    ], 'GA Create Account menu item');
  }
  await waitRendered(s.page, 40).catch(() => '');
}

async function fillGoogleAnalyticsAccountStep(s, values) {
  const scope = await visibleFormScope(s.page);
  const filled = await fillDomInput(s.page, [
    'input[debug-id="account-name-input"]',
    'ga-account-setup input:not([type="hidden"])',
  ], values.accountName);
  if (!filled && !await fillWithinOrNth(scope, s.page, values.accountName, [/account name/i, /^name$/i], 0)) {
    throw new Error('GA account-name field was not fillable');
  }
  if (!await clickDomElement(s.page, ['button[debug-id="account-next-step-button"]'], /^Next$/i)) {
    await clickGaNext(s.page, 'GA account setup next button', /Property creation/i);
    return;
  }
  await waitForGaStep(s.page, /Property creation/i, 'GA account setup next button');
}

async function fillGoogleAnalyticsPropertyStep(s, values) {
  const scope = await visibleFormScope(s.page);
  const filled = await fillDomInput(s.page, [
    'input[data-guidedhelpid="property-name-input"]',
    'input[debug-id="property-name-input"]',
    'ga-property-setup input:not([type="hidden"])',
  ], values.propertyName);
  if (!filled && !await fillWithinOrNth(scope, s.page, values.propertyName, [/property name/i, /^name$/i], 0)) {
    throw new Error('GA property-name field was not fillable');
  }
  await setOptionalDropdown(s.page, [/reporting time zone/i, /time zone/i], values.timezone).catch(() => false);
  await setOptionalDropdown(s.page, [/currency/i], values.currency).catch(() => false);
  if (!await clickDomElement(s.page, ['button[debug-id="property-next-step-button"]'], /^Next$/i)) {
    await clickGaNext(s.page, 'GA property setup next button', /Business details/i);
    return;
  }
  await waitForGaStep(s.page, /Business details/i, 'GA property setup next button');
}

async function fillGoogleAnalyticsBusinessStep(s) {
  await setGoogleAnalyticsIndustry(s.page).catch(() => false);
  if (!await setGoogleAnalyticsBusinessSize(s.page).catch(() => false)) {
    await selectVisibleChoice(s.page, [/small/i, /1 to 10/i, /medium/i]).catch(() => false);
  }
  await clickGaNext(s.page, 'GA business details next button', /Business objectives/i);
}

async function fillGoogleAnalyticsObjectivesStep(s) {
  if (!await setGoogleAnalyticsObjective(s.page).catch(() => false)) {
    await selectVisibleChoice(s.page, [/understand web/i, /other business objectives/i, /examine user behavior/i, /traffic/i]).catch(() => false);
  }
  await clickGoogleAnalyticsCreateButton(s.page);
  await waitForGaStepOrText(s.page, /Data collection/i, /terms|service agreement|data collection|platform|web stream|website url/i, 'GA business objectives create button');
}

async function acceptGoogleAnalyticsTermsIfPresent(s) {
  const text = await bodyText(s.page);
  if (!/terms|service agreement|data processing|privacy/i.test(text)) return;

  const dialog = s.page.getByRole('dialog')
    .filter({ hasText: /Terms of Service Agreement|Data Processing Terms|I Accept/i })
    .filter({ visible: true })
    .first();
  if (await dialog.isVisible().catch(() => false)) {
    const requiredBox = dialog.locator('input[type="checkbox"]').first();
    if (await requiredBox.count().catch(() => 0)) {
      await requiredBox.check({ force: true, timeout: 5000 }).catch(() => {});
      await humanIdlePause('short');
    }
    const acceptButton = dialog.locator('button[debug-id="accept-button"], button').filter({ hasText: /^I Accept$/i });
    for (let i = 0; i < 30; i++) {
      if (await clickAnyLocator(s.page, [acceptButton]).catch(() => false)) {
        await waitForGaStepOrText(s.page, /Data collection/i, /data collection|platform|web stream|website url/i, 'GA terms accept button');
        return;
      }
      await humanIdlePause('short');
    }
    throw new Error('GA Terms accept button was not enabled');
  }

  const boxes = s.page.locator('mat-checkbox, input[type="checkbox"], [role="checkbox"]').filter({ visible: true });
  const count = await boxes.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 6); i++) {
    const box = boxes.nth(i);
    const checked = await box.getAttribute('aria-checked').catch(() => null);
    if (checked !== 'true') await clickLocator(s.page, box).catch(() => {});
  }
  await clickFirst(s.page, [/^I accept$/i, /^Accept$/i, /^Agree$/i, /^Create$/i]).catch(() => false);
  await waitRendered(s.page, 40).catch(() => '');
}

async function fillGoogleAnalyticsWebStreamStep(s, values) {
  for (let i = 0; i < 8; i++) {
    const text = await bodyText(s.page);
    if (await s.page.locator('ga-admin-web-stream-editor').filter({ visible: true }).first().isVisible().catch(() => false)) break;
    if (/web stream|website url|stream name|choose a platform|data stream|set up a data stream/i.test(text)) {
      await clickAnyLocator(s.page, [
        s.page.locator('button[debug-id="create-web-stream-button"]'),
        s.page.locator('[data-guidedhelpid="data-stream-choose-web"]'),
        s.page.getByRole('button', { name: /^Web$/i }),
        s.page.locator('button').filter({ hasText: /^Web$/i }),
      ]).catch(() => false);
    } else {
      await clickFirst(s.page, [/^Web$/i, /Web stream/i, /Data streams/i, /Create stream/i]).catch(() => false);
    }
    await humanIdlePause('short');
  }

  const editor = s.page.locator('ga-admin-web-stream-editor').filter({ visible: true }).first();
  if (!await editor.isVisible().catch(() => false)) {
    await clickAnyLocator(s.page, [
      s.page.locator('button[debug-id="create-web-stream-button"]'),
      s.page.locator('[data-guidedhelpid="data-stream-choose-web"]'),
      s.page.getByRole('button', { name: /^Web$/i }),
      s.page.locator('button').filter({ hasText: /^Web$/i }),
    ], 'GA Web stream platform button');
  }
  for (let i = 0; i < 30 && !await editor.isVisible().catch(() => false); i++) await humanIdlePause('short');
  if (!await editor.isVisible().catch(() => false)) throw new Error('GA web stream editor did not open');

  const website = editor.locator('input[debug-id="website-url-input"]').first();
  const streamName = editor.locator('input[debug-id="stream-name-input"]').first();
  if (!await website.isVisible().catch(() => false) || !await streamName.isVisible().catch(() => false)) {
    throw new Error('GA web stream fields were not visible');
  }
  await humanFill(s.page, website, siteHostname(values.siteUrl));
  await humanFill(s.page, streamName, values.streamName);
  let clickedCreate = false;
  for (let i = 0; i < 30; i++) {
    if (await clickAnyLocator(s.page, [editor.locator('button[debug-id="create-stream-button"]')]).catch(() => false)) {
      clickedCreate = true;
      break;
    }
    await humanIdlePause('short');
  }
  if (!clickedCreate) throw new Error('GA web stream Create and continue button was not enabled');
  await waitRendered(s.page, 80).catch(() => '');
}

async function openGoogleAnalyticsCreatedStreamDetail(s, values) {
  const streamName = new RegExp(escapeRegExp(values.streamName), 'i');
  let opened = false;
  for (let i = 0; i < 30; i++) {
    const text = await bodyText(s.page);
    if (/Measurement ID|View tag instructions|Tag instructions|Stream details/i.test(text)) {
      opened = true;
      break;
    }

    const row = s.page.locator('mat-row, tr, [role="row"]')
      .filter({ hasText: streamName })
      .filter({ visible: true })
      .first();
    if (await row.isVisible().catch(() => false)) {
      const streamId = await row.locator('[debug-id="stream-entity-id"]').first().innerText({ timeout: 2000 }).catch(() => '');
      const arrow = row.locator('button[aria-label="Select stream"], button').filter({ visible: true }).last();
      if (!await clickAnyLocator(s.page, [arrow]).catch(() => false)) await row.click({ timeout: 5000, force: true }).catch(() => {});
      for (let j = 0; j < 30; j++) {
        const detailText = await bodyText(s.page);
        if (/Measurement ID|View tag instructions|Tag instructions|Stream details/i.test(detailText)) {
          opened = true;
          break;
        }
        await humanIdlePause('short');
      }
      if (opened || streamId) break;
      break;
    }
    await humanIdlePause('short');
  }

  if (opened) {
    await clickAnyLocator(s.page, [
      s.page.getByRole('button', { name: /View tag instructions|Tag instructions|Google tag|Installation instructions/i }),
      s.page.locator('button, [role="button"], a').filter({ hasText: /View tag instructions|Tag instructions|Google tag|Installation instructions/i }),
    ]).catch(() => false);
    await waitRendered(s.page, 80).catch(() => '');
  }
}

async function googleAnalyticsRegisterSite(s) {
  const values = gaRegistrationInputs();
  await openGoogleAnalyticsCreateAccount(s);
  await fillGoogleAnalyticsAccountStep(s, values);
  await fillGoogleAnalyticsPropertyStep(s, values);
  await fillGoogleAnalyticsBusinessStep(s, values);
  await fillGoogleAnalyticsObjectivesStep(s, values);
  await acceptGoogleAnalyticsTermsIfPresent(s);
  await fillGoogleAnalyticsWebStreamStep(s, values);
  await openGoogleAnalyticsCreatedStreamDetail(s, values);

  for (let i = 0; i < 60; i++) {
    const text = await bodyText(s.page);
    const measurementId = extractGaMeasurementId(text);
    if (measurementId) {
      return { registration: { ...values, measurementId } };
    }
    await humanIdlePause('short');
  }
  const text = await bodyText(s.page);
  throw new Error(`GA registration completed no visible measurement id; final_url=${s.page.url()}; body_preview=${text.slice(0, 800).replace(/\s+/g, ' ')}`);
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
  if (!login) {
    const googleCreds = await getGoogleSsoCreds();
    const clickedGoogle = googleCreds
      ? await clickFirst(s.page, [/continue with google/i, /sign in with google/i, /^google$/i])
      : false;
    if (clickedGoogle) {
      const ok = await googleSso(s, googleCreds, { originHost: 'cloud.umami.is' });
      if (ok) return true;
    }
    throw new Error('no usable Umami login: add service_credentials display_name=Umami or UMAMI_EMAIL/UMAMI_PASSWORD; Umami Cloud did not expose a Google SSO button');
  }
  await fillAny(s.page, login.email, [/email/i, /user/i]);
  await fillAny(s.page, login.password, [/password/i]);
  await clickFirst(s.page, [/^log in$/i, /^login$/i, /^sign in$/i, /^continue$/i]);
  for (let i = 0; i < 20; i++) {
    await humanIdlePause('short');
    if (!/login|signin/i.test(s.page.url())) return true;
  }
  const passwordInput = s.page.locator('input[type="password"], input[name="password"]').filter({ visible: true }).first();
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.press('Enter').catch(() => {});
  }
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
    if (action === 'googleanalytics_get_global_site_tag') {
      const streamId = input('STREAM_ID');
      return streamId && streamId !== 'unknown-stream'
        ? propertyRoute(`admin/streams/table/${streamId}`)
        : propertyRoute('admin/streams/table');
    }
    if (action.includes('acquisition')) return propertyRoute('reports/acquisition');
    if (action.includes('engagement')) return propertyRoute('reports/engagement');
    if (action.includes('pages')) return propertyRoute('reports/engagement/pages-and-screens');
    if (action === 'googleanalytics_export_report') return propertyRoute('reports/engagement/pages-and-screens');
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
    return;
  }
  const paths = {
    googleanalytics_view_acquisition: [/^Reports$/i, /^Acquisition$/i],
    googleanalytics_view_engagement: [/^Reports$/i, /^Engagement$/i],
    googleanalytics_view_pages: [/^Reports$/i, /^Engagement$/i, /^Pages and screens$/i],
    googleanalytics_export_report: [/^Reports$/i, /^Engagement$/i, /^Pages and screens$/i],
    googleanalytics_view_key_events: [/^Admin$/i, /^Events$/i],
    googleanalytics_view_debugview: [/^Admin$/i, /^DebugView$/i],
    googleanalytics_get_global_site_tag: [/^Admin$/i, /^Data streams$/i],
  };
  const path = paths[action];
  if (!path) return;
  for (const label of path) {
    const clicked = await clickFirst(s.page, [label]);
    if (!clicked) await clickCardLike(s.page, label);
    await waitRendered(s.page, 30).catch(() => '');
    if (action === 'googleanalytics_view_key_events' && /Events/i.test(String(label)) && /\/admin$/.test(s.page.url())) {
      await clickCardLike(s.page, label);
      await waitRendered(s.page, 30).catch(() => '');
    }
    if (action === 'googleanalytics_get_global_site_tag' && /Data streams/i.test(String(label)) && /\/admin$/.test(s.page.url())) {
      await clickCardLike(s.page, label);
      await waitRendered(s.page, 30).catch(() => '');
    }
    await humanIdlePause('deliberate');
  }
  if (action === 'googleanalytics_get_global_site_tag') {
    await openDataStreamDetail(s);
    await waitRendered(s.page, 30).catch(() => '');
    await clickFirst(s.page, [/View tag instructions/i, /Tag instructions/i, /^Google tag$/i]);
    await waitRendered(s.page, 30).catch(() => '');
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
  if (cfg.platform === 'umami' && action === 'umami_register') {
    return umamiRegisterAccount(s);
  }
  if (cfg.platform === 'umami' && action === 'umami_create_website') {
    await umamiCreateWebsite(s);
    return { registration: { domain: input('DOMAIN') } };
  }
  if (cfg.platform === 'umami' && action === 'umami_update_website_settings') {
    await clickFirst(s.page, [/settings/i, /edit/i]);
    const patch = input('SETTINGS_PATCH');
    if (patch) await fillAny(s.page, patch, [/name/i, /domain/i, /timezone/i]);
    await clickFirst(s.page, [/save/i, /update/i]);
    return {};
  }
  if (cfg.platform === 'googleanalytics' && (action === 'googleanalytics_register' || action === 'googleanalytics_register_needher')) {
    return googleAnalyticsRegisterSite(s);
  }
  if (cfg.platform === 'googleanalytics') {
    await clickFirst(s.page, [/admin/i, /create/i, /new/i, /add/i]);
    await fillAny(s.page, input('ACCOUNT_NAME') || input('PROPERTY_NAME') || input('STREAM_NAME') || input('EVENT_NAME') || input('USER_EMAIL') || input('DIMENSION_NAME') || input('METRIC_NAME') || input('NICKNAME'), [/name/i, /email/i, /event/i, /stream/i, /property/i, /nickname/i]);
    await fillAny(s.page, input('SITE_URL'), [/url/i, /website/i]);
    await fillAny(s.page, input('ROLE'), [/role/i]);
    await clickFirst(s.page, [/save/i, /create/i, /submit/i, /add/i, /next/i]);
    return {};
  }
  await clickFirst(s.page, [/create/i, /save/i, /add/i, /update/i]);
  return {};
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
  try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: cfg.platform !== 'googleanalytics', timeout: 15000 }); } catch {}
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
  if (action === 'googleanalytics_view_key_events' && /\/admin$/.test(evidence.url)) {
    throw new Error(`GA events settings did not open; final_url=${evidence.url}`);
  }
  if (action === 'googleanalytics_run_data_api_report' && evidence.url.includes('/reports/intelligenthome')) {
    throw new Error(`GA data report did not run; final_url=${evidence.url}`);
  }
  if (action === 'googleanalytics_export_report' && evidence.url.includes('/reports/intelligenthome')) {
    throw new Error(`GA export report did not open an exportable report; final_url=${evidence.url}`);
  }
  if ((action === 'umami_find_website' || action === 'umami_get_website_id') && !new RegExp(escapeRegExp(input('DOMAIN_OR_NAME')), 'i').test(text)) {
    throw new Error(`Umami website ${input('DOMAIN_OR_NAME')} was not visible in the captured page`);
  }
  if (action === 'umami_create_website' && !new RegExp(escapeRegExp(input('DOMAIN')), 'i').test(text)) {
    throw new Error(`Umami website ${input('DOMAIN')} was not visible in the captured page`);
  }
  if (action === 'umami_register' && !/verify|verification|check your email|confirm your email|dashboard|websites|account/i.test(text)) {
    throw new Error('Umami registration did not reach a verification or account state');
  }
  if ((action === 'googleanalytics_register' || action === 'googleanalytics_register_needher') && !extractGaMeasurementId(`${text} ${JSON.stringify(evidence.registration ?? {})}`)) {
    throw new Error('GA registration did not expose a measurement id');
  }
  const expectedSections = {
    googleanalytics_view_acquisition: /Acquisition/i,
    googleanalytics_view_engagement: /Engagement/i,
    googleanalytics_view_pages: /Pages and screens|Page title and screen name/i,
    googleanalytics_view_key_events: /Events|Key events/i,
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
    if (name !== 'umami_register' && !name.includes('verify_tracking_script') && !name.includes('track_custom_event') && !name.includes('install_gtag')) {
      await ensureLoggedIn(s, cfg);
      await store.capturePlaywright?.(s.ctx, cfg.platform).catch(() => {});
    }

    const pending = (cfg.risk === 'write' || cfg.risk === 'admin') && await prepareWrite(s, cfg);
    if (pending) {
      await safeGoto(s, resolvedUrl(cfg));
      await captureEvidence(s, cfg, { pending_review: true });
      writeBanSignal('pending_review', true, { risk: cfg.risk, reason: 'write/admin action staged for approval' });
      console.log(`PASS: ${name} pending_review`);
      return;
    }

    let extra = {};
    if (name === 'googleanalytics_verify_realtime') {
      extra.targetSite = await verifyTargetSite(s, cfg);
      await safeGoto(s, resolvedUrl(cfg));
      await humanIdlePause('long');
      await openExpectedDashboardSection(s);
    } else if (name.includes('verify_tracking_script') || name === 'umami_track_custom_event' || name === 'googleanalytics_install_gtag') {
      extra.targetSite = await verifyTargetSite(s, cfg);
    } else {
      await safeGoto(s, resolvedUrl(cfg));
      await humanIdlePause('long');
      if (cfg.platform === 'googleanalytics') await openExpectedDashboardSection(s);
      if (name !== 'googleanalytics_register' && name !== 'googleanalytics_register_needher') {
        for (let i = 0; i < 2; i++) await humanScroll(s.page, 800, 2).catch(() => {});
      }
      if (cfg.risk === 'write' || cfg.risk === 'admin') {
        extra = { ...extra, ...await performConfirmedWrite(s, cfg) };
      }
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
