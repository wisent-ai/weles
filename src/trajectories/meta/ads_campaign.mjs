// Meta Ads Manager: create/fill a campaign draft in the browser.
//
// Env:
//   AD_ACCOUNT_ID        required unless ADS_URL is set; numeric or act_<id>
//   ADS_URL              optional direct Ads Manager creation URL
//   CAMPAIGN_NAME        optional, defaults to timestamped name
//   CAMPAIGN_OBJECTIVE   optional objective label text, e.g. Traffic, Leads
//   CAMPAIGN_DESTINATION optional destination family. Supported: website
//   DAILY_BUDGET_USD     optional daily budget
//   DESTINATION_URL      optional landing page URL
//   DISPLAY_LINK         optional visible display link
//   URL_PARAMS           optional URL tracking params
//   AD_NAME              optional ad name
//   AD_SET_NAME          optional ad set name
//   META_FACEBOOK_PAGE_NAME optional Facebook Page to select
//   META_FACEBOOK_PAGE_ID   optional Facebook Page id to select
//   PRIMARY_TEXT         optional ad primary text
//   HEADLINE             optional ad headline
//   DESCRIPTION          optional ad description
//   META_ADS_CAPABILITIES print supported params and exit
//   ALLOW_UNVERIFIED_META_PARAMS set "1" to warn instead of failing for unsupported params
//   SUBMIT               must be "1" to publish. Default stages only.
//   PROXY_URL            optional proxy override
//
// Requires a logged-in facebook account cookie jar. Run meta/facebook_login.mjs
// first when the session is stale.

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ADS_URL = process.env.ADS_URL;
const RAW_AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID || process.env.META_ADS_COMPANY_ACCOUNT_ID;
const AD_ACCOUNT_ID = RAW_AD_ACCOUNT_ID?.replace(/^act_/, '');
const BUSINESS_ID = process.env.BUSINESS_ID || process.env.META_BUSINESS_ID;
const AD_ACCOUNT_NAME = process.env.AD_ACCOUNT_NAME || process.env.META_ADS_ACCOUNT_NAME;
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME || `Wisent ${new Date().toISOString().slice(0, 19)}`;
const CAMPAIGN_OBJECTIVE = process.env.CAMPAIGN_OBJECTIVE || 'Traffic';
const CAMPAIGN_DESTINATION = (process.env.CAMPAIGN_DESTINATION || process.env.DESTINATION_TYPE || 'website').toLowerCase();
const DAILY_BUDGET_USD = process.env.DAILY_BUDGET_USD;
const DESTINATION_URL = process.env.DESTINATION_URL || process.env.FINAL_URL;
const DISPLAY_LINK = process.env.DISPLAY_LINK;
const URL_PARAMS = process.env.URL_PARAMS;
const AD_SET_NAME = process.env.AD_SET_NAME || `${CAMPAIGN_NAME} ad set`;
const AD_NAME = process.env.AD_NAME || `${CAMPAIGN_NAME} ad`;
const FACEBOOK_PAGE_NAME = process.env.META_FACEBOOK_PAGE_NAME || process.env.FACEBOOK_PAGE_NAME;
const FACEBOOK_PAGE_ID = process.env.META_FACEBOOK_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
const PRIMARY_TEXT = process.env.PRIMARY_TEXT;
const HEADLINE = process.env.HEADLINE;
const DESCRIPTION = process.env.DESCRIPTION;
const SUBMIT = process.env.SUBMIT === '1';
const PRINT_CAPABILITIES = process.env.META_ADS_CAPABILITIES === '1';
const ALLOW_UNVERIFIED_META_PARAMS = process.env.ALLOW_UNVERIFIED_META_PARAMS === '1';
const WAIT_FOR_LOGIN = process.env.WAIT_FOR_LOGIN === '1';
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 10 * 60 * 1000);
const VERIFY_ACCOUNT_ONLY = process.env.VERIFY_ACCOUNT_ONLY === '1';
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

const acct = await getSocialAccount('facebook');
const session = acct ? await resolveAccountSession(acct) : { proxyUrl: undefined, persona: undefined };
const profilePersona = process.env.ADS_PROFILE_PERSONA === 'account' && session.persona ? session.persona : stableProfilePersona();

const OBJECTIVE_ALIASES = {
  traffic: ['Traffic', 'Ruch'],
  ruch: ['Ruch', 'Traffic'],
  leads: ['Leads', 'Potencjalni klienci'],
  lead: ['Leads', 'Potencjalni klienci'],
  sales: ['Sales', 'Sprzedaż'],
  sprzedaż: ['Sprzedaż', 'Sales'],
  engagement: ['Engagement', 'Aktywność'],
  awareness: ['Awareness', 'Świadomość'],
  app: ['App promotion', 'Promocja aplikacji'],
  app_promotion: ['App promotion', 'Promocja aplikacji'],
};
const objectiveKey = CAMPAIGN_OBJECTIVE.toLowerCase().replace(/\s+/g, '_');
const objectiveLabels = Array.from(new Set([
  CAMPAIGN_OBJECTIVE,
  ...(OBJECTIVE_ALIASES[objectiveKey] || []),
].filter(Boolean)));

const CAPABILITIES = {
  verified: {
    create: ['website traffic campaign draft', 'existing draft configuration via ADS_URL'],
    read: ['campaign table/performance browser fallback'],
    update: ['existing draft fields via ADS_URL', 'CLI update when Meta CLI exists'],
    publish: 'guarded by SUBMIT=1; not used in verification',
  },
  supportedParams: [
    'AD_ACCOUNT_ID', 'META_ADS_COMPANY_ACCOUNT_ID', 'BUSINESS_ID', 'META_BUSINESS_ID', 'AD_ACCOUNT_NAME',
    'ADS_URL', 'CAMPAIGN_NAME', 'CAMPAIGN_OBJECTIVE', 'CAMPAIGN_DESTINATION=website',
    'AD_SET_NAME', 'AD_NAME', 'META_FACEBOOK_PAGE_NAME', 'META_FACEBOOK_PAGE_ID',
    'DESTINATION_URL', 'DISPLAY_LINK', 'URL_PARAMS', 'DAILY_BUDGET_USD',
    'PRIMARY_TEXT', 'HEADLINE', 'DESCRIPTION', 'SUBMIT',
  ],
  objectiveLabelsAcceptedForSelection: Object.values(OBJECTIVE_ALIASES).flat(),
  unsupportedWithoutCustomExtension: [
    'catalog/product-set campaigns',
    'app install / app event setup',
    'lead forms',
    'WhatsApp / Messenger destinations',
    'Advantage+ shopping end-to-end setup',
    'custom audiences, lookalikes, detailed targeting',
    'creative media upload',
    'placement matrix and bid strategy tuning',
  ],
};

function printCapabilitiesAndExit() {
  console.log(JSON.stringify(CAPABILITIES, null, 2));
  process.exit(0);
}

function guardUnsupportedParams() {
  const unsupported = [];
  const unsupportedEnv = [
    'PRODUCT_SET_ID',
    'CATALOG_ID',
    'APP_ID',
    'APP_EVENT',
    'LEAD_FORM_ID',
    'WHATSAPP_NUMBER',
    'MESSENGER_DESTINATION',
    'CUSTOM_AUDIENCE_ID',
    'LOOKALIKE_SOURCE_ID',
    'PLACEMENTS',
    'BID_STRATEGY',
    'OPTIMIZATION_GOAL',
    'BILLING_EVENT',
    'CREATIVE_ASSET_PATH',
    'IMAGE_PATH',
    'VIDEO_PATH',
  ];
  for (const key of unsupportedEnv) {
    if (process.env[key]) unsupported.push(key);
  }
  if (CAMPAIGN_DESTINATION !== 'website') unsupported.push(`CAMPAIGN_DESTINATION=${CAMPAIGN_DESTINATION}`);
  const knownObjective = OBJECTIVE_ALIASES[objectiveKey] || /^(traffic|ruch)$/i.test(CAMPAIGN_OBJECTIVE);
  if (!knownObjective) unsupported.push(`CAMPAIGN_OBJECTIVE=${CAMPAIGN_OBJECTIVE}`);
  if (!unsupported.length) return;
  const msg = `unsupported/unverified Meta campaign params: ${unsupported.join(', ')}. Supported verified destination is website traffic draft/configuration.`;
  if (!ALLOW_UNVERIFIED_META_PARAMS) {
    console.log(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`[meta-ads] WARN: ${msg}`);
}

if (PRINT_CAPABILITIES) printCapabilitiesAndExit();
guardUnsupportedParams();

if (!ADS_URL && !AD_ACCOUNT_ID && !WAIT_FOR_LOGIN) {
  console.log('FAIL: AD_ACCOUNT_ID or ADS_URL required');
  process.exit(1);
}

async function clickAny(s, selectors, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = s.page.locator(sel).filter({ visible: true }).first();
      if (await withTimeout(loc.isVisible(), 1500, false).catch(() => false)) {
        const clicked = await withTimeout(humanClickLocator(s.page, loc), 5000, false).catch(() => false);
        if (!clicked) {
          const box = await loc.boundingBox().catch(() => null);
          if (!box) {
            console.log(`[meta-ads] WARN: click timed out: ${label} (${sel})`);
            continue;
          }
          await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
          await s.wait(0.2);
          await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          console.log(`[meta-ads] clicked with mouse fallback: ${label}`);
        } else {
          console.log(`[meta-ads] clicked: ${label}`);
        }
        await humanIdlePause('short');
        return true;
      }
    }
    await s.wait(1);
  }
  return false;
}

async function clickVisibleTextInArea(s, textRe, label, area, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await s.page.evaluate((source, flags, a) => {
      const re = new RegExp(source, flags);
      const els = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
      for (const el of els) {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!re.test(text)) continue;
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (!r.width || !r.height || style.visibility === 'hidden' || style.display === 'none') continue;
        if (a?.minX != null && r.left < a.minX) continue;
        if (a?.maxX != null && r.left > a.maxX) continue;
        if (a?.minY != null && r.top < a.minY) continue;
        if (a?.maxY != null && r.top > a.maxY) continue;
        if (a?.minW != null && r.width < a.minW) continue;
        if (a?.minH != null && r.height < a.minH) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text, tag: el.tagName, role: el.getAttribute('role') };
      }
      return null;
    }, textRe.source, textRe.flags, area).catch(() => null);
    if (candidate) {
      await s.page.mouse.move(candidate.x, candidate.y);
      await s.wait(0.2);
      await s.page.mouse.click(candidate.x, candidate.y);
      console.log(`[meta-ads] clicked: ${label} (${candidate.text})`);
      await humanIdlePause('short');
      return true;
    }
    await s.wait(1);
  }
  return false;
}

async function clickPoint(s, x, y, label) {
  await s.page.mouse.move(x, y).catch(() => {});
  await s.wait(0.2);
  await s.page.mouse.click(x, y);
  console.log(`[meta-ads] clicked point: ${label} (${x},${y})`);
  await humanIdlePause('short');
  return true;
}

async function closeObstructingPanels(s) {
  await clickVisibleTextInArea(s, /^×$|^Zamknij$/i, 'close panel', { minX: 1150, minY: 150 }, 1500);
  await clickAny(s, [
    '[aria-label="Close"]',
    '[aria-label="Zamknij"]',
    'div[role="button"]:has-text("×")',
  ], 'close overlay', 1500);
}

async function fillAny(s, selectors, value, label) {
  if (!value) return false;
  for (const sel of selectors) {
    const loc = s.page.locator(sel).filter({ visible: true }).first();
    if (await withTimeout(loc.isVisible(), 1500, false).catch(() => false)) {
      const filled = await withTimeout(humanFill(s.page, loc, String(value)), 6000, false).catch(() => false);
      if (!filled) {
        console.log(`[meta-ads] WARN: fill timed out: ${label} (${sel})`);
        continue;
      }
      console.log(`[meta-ads] filled: ${label}`);
      await humanIdlePause('short');
      return true;
    }
  }
  console.log(`[meta-ads] WARN: field not found: ${label}`);
  return false;
}

async function fillAnyReliable(s, selectors, value, label) {
  if (!value) return false;
  for (const sel of selectors) {
    const loc = s.page.locator(sel).first();
    if (!await withTimeout(loc.count(), 1500, 0).catch(() => 0)) continue;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    if (!await withTimeout(loc.isVisible(), 1500, false).catch(() => false)) continue;
    const before = await loc.evaluate((el) => el.value ?? el.innerText ?? el.textContent ?? '').catch(() => '');
    if (String(before).trim() === String(value).trim()) {
      console.log(`[meta-ads] already filled: ${label}`);
      return true;
    }
    await humanFill(s.page, loc, String(value)).catch(() => {});
    await humanIdlePause('short');
    const directFirst = await loc.evaluate((el) => el.value ?? el.innerText ?? el.textContent ?? '').catch(() => '');
    if (String(directFirst).trim() === String(value).trim()) {
      console.log(`[meta-ads] filled directly: ${label}`);
      return true;
    }
    await loc.evaluate((el, v) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) desc.set.call(el, v);
      else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value)).catch(() => {});
    await humanIdlePause('short');
    const nativeFirst = await loc.evaluate((el) => el.value ?? el.innerText ?? el.textContent ?? '').catch(() => '');
    if (String(nativeFirst).trim() === String(value).trim()) {
      console.log(`[meta-ads] set native value: ${label}`);
      return true;
    }
    const filled = await withTimeout(humanFill(s.page, loc, String(value)), 8000, false).catch(() => false);
    await humanIdlePause('short');
    const actual = await loc.evaluate((el) => el.value ?? el.innerText ?? el.textContent ?? '').catch(() => '');
    if (filled && String(actual).trim() === String(value).trim()) {
      console.log(`[meta-ads] filled: ${label}`);
      return true;
    }
    console.log(`[meta-ads] WARN: field value mismatch: ${label} expected=${JSON.stringify(String(value))} actual=${JSON.stringify(String(actual || nativeFirst || directFirst).slice(0, 120))}`);
    const box = await loc.boundingBox().catch(() => null);
    if (!box) continue;
    await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await s.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await s.page.keyboard.press('Backspace').catch(() => {});
    await humanType(s.page, String(value));
    await humanIdlePause('short');
    const typed = await loc.evaluate((el) => el.value ?? el.innerText ?? el.textContent ?? '').catch(() => '');
    if (String(typed).trim() === String(value).trim()) {
      console.log(`[meta-ads] typed: ${label}`);
      return true;
    }
    console.log(`[meta-ads] WARN: field value mismatch: ${label} expected=${JSON.stringify(String(value))} actual=${JSON.stringify(String(typed).slice(0, 120))}`);
  }
  console.log(`[meta-ads] WARN: field not found: ${label}`);
  return false;
}

async function clickNext(s, timeoutMs = 6000) {
  return await clickAny(s, [
    'div[role="button"]:has-text("Dalej")',
    'button:has-text("Dalej")',
    'div[role="button"]:has-text("Next")',
    'button:has-text("Next")',
  ], 'Next/Dalej', timeoutMs);
}

async function selectFacebookPage(s) {
  if (!FACEBOOK_PAGE_NAME && !FACEBOOK_PAGE_ID) return false;
  const opened = await clickAny(s, [
    'div[role="combobox"]:has-text("Wybierz stronę")',
    'div[role="combobox"]:has-text("Select a Page")',
    'div[role="combobox"]:has-text("Select Page")',
  ], 'Facebook Page selector', 5000);
  if (!opened) {
    const text = await pageText(s);
    if (FACEBOOK_PAGE_NAME && text.includes(FACEBOOK_PAGE_NAME)) {
      console.log(`[meta-ads] Facebook Page already selected: ${FACEBOOK_PAGE_NAME}`);
      return true;
    }
    return false;
  }
  await s.wait(2);
  const target = await s.page.evaluate(({ name, id }) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const els = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], div, span'));
    for (const el of els) {
      const text = norm(el.innerText || el.textContent || '');
      if (!text) continue;
      if (id && text.includes(id)) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 18), text };
      }
      if (name && (text === name || text.startsWith(`${name} Identyfikator:`) || text.startsWith(`${name} Identifier:`))) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 18), text };
      }
    }
    return null;
  }, { name: FACEBOOK_PAGE_NAME, id: FACEBOOK_PAGE_ID }).catch(() => null);
  if (!target) {
    console.log(`[meta-ads] WARN: Facebook Page option not found: name=${FACEBOOK_PAGE_NAME || ''} id=${FACEBOOK_PAGE_ID || ''}`);
    return false;
  }
  await s.page.mouse.click(target.x, target.y);
  console.log(`[meta-ads] selected Facebook Page: ${target.text.slice(0, 120)}`);
  await s.wait(4);
  return true;
}

async function verifyConfiguredDraft(s) {
  await clickAny(s, [
    'div[role="tab"]:has-text("Sprawdź")',
    'div[role="tab"]:has-text("Review")',
  ], 'Review/Sprawdź tab', 5000);
  await s.wait(3);
  const text = await pageText(s);
  const checks = [
    [CAMPAIGN_NAME, 'campaign name'],
    [AD_SET_NAME, 'ad set name'],
    [AD_NAME, 'ad name'],
    [FACEBOOK_PAGE_NAME, 'Facebook Page'],
    [DESTINATION_URL, 'destination URL'],
  ].filter(([value]) => value);
  const missing = checks.filter(([value]) => !text.includes(value)).map(([, label]) => label);
  if (missing.length) {
    console.log(`FAIL: Meta Ads draft verification missing ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!/Wersja robocza|Draft/i.test(text)) {
    console.log('FAIL: Meta Ads draft verification did not find draft state');
    process.exit(1);
  }
  if (!/Wszystkie zmiany zapisane|All changes saved/i.test(text)) {
    console.log('[meta-ads] WARN: draft configured but save confirmation not visible');
  }
  return true;
}

async function pageText(s) {
  return await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function visibleControlDebug(s) {
  return await s.page.evaluate(() => Array.from(document.querySelectorAll('button,[role="button"],[role="radio"],div,span,a'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const style = window.getComputedStyle(el);
      return {
        text: text.slice(0, 80),
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        tag: el.tagName,
        role: el.getAttribute('role'),
        visible: !!r.width && !!r.height && style.display !== 'none' && style.visibility !== 'hidden',
      };
    })
    .filter((e) => e.visible && /Utwórz|Create|Ruch|Traffic|Kontynuuj|Continue|Przegląd konta|account/i.test(e.text))
    .slice(0, 80)).catch(() => []);
}

function selectedCampaignId(url) {
  try {
    return new URL(url).searchParams.get('selected_campaign_ids') || null;
  } catch {
    return null;
  }
}

async function maybeContinueCampaignConfiguration(s) {
  const text = await pageText(s);
  if (!/Wybierz konfigurację kampanii|Choose campaign setup|Ręcznie utworzona kampania|Zalecane ustawienia/i.test(text)) {
    return false;
  }
  await clickAny(s, [
    'div[role="button"]:has-text("Kontynuuj")',
    'button:has-text("Kontynuuj")',
    'div[role="button"]:has-text("Continue")',
    'button:has-text("Continue")',
  ], 'configuration Continue', 5000);
  await clickVisibleTextInArea(s, /^(Kontynuuj|Continue)$/i, 'configuration Continue', {
    minX: 760,
    maxX: 1100,
    minY: 500,
    maxY: 820,
    minW: 60,
    minH: 30,
  }, 4000);
  await s.wait(8);
  return true;
}

function withTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

async function bringBrowserToFront(s) {
  await s.page.bringToFront().catch(() => {});
  if (process.platform !== 'darwin') return;
  spawnSync('osascript', ['-e', 'tell application "Chromium" to activate'], { stdio: 'ignore' });
  spawnSync('osascript', ['-e', 'tell application "System Events" to set frontmost of every process whose name is "Chromium" to true'], { stdio: 'ignore' });
}

function isLoginUrl(url) {
  return /facebook\.com\/login|business\.facebook\.com\/business\/loginpage|checkpoint|recover/i.test(url);
}

function currentAdAccountId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('act')?.replace(/^act_/, '') || null;
  } catch {
    return null;
  }
}

async function visibleSelectedAdAccount(s) {
  const text = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const accountLine = text.split('\n').map((line) => line.trim()).find((line) => /\(\d{6,}\)/.test(line));
  const id = accountLine?.match(/\((\d{6,})\)/)?.[1] || null;
  return { id, label: accountLine || null };
}

async function ensureAdAccount(s) {
  const before = currentAdAccountId(s.page.url?.() ?? '');
  console.log(`[meta-ads] current ad account=${before || 'unknown'} target=${AD_ACCOUNT_ID || 'unspecified'}`);
  if (!AD_ACCOUNT_ID) return before;

  if (before !== AD_ACCOUNT_ID) {
    const params = new URLSearchParams({ act: AD_ACCOUNT_ID });
    if (BUSINESS_ID) params.set('business_id', BUSINESS_ID);
    const switchUrl = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?${params}`;
    console.log(`[meta-ads] switching ad account -> ${AD_ACCOUNT_ID}`);
    await s.goto(switchUrl);
    await s.wait(8);
  }
  const after = currentAdAccountId(s.page.url?.() ?? '');
  const visible = await visibleSelectedAdAccount(s);
  console.log(`[meta-ads] ad account after switch=${after || 'unknown'} visible=${visible.label || 'unknown'}`);
  if (after !== AD_ACCOUNT_ID) {
    console.log(`FAIL: wrong Meta ad account selected; expected=${AD_ACCOUNT_ID} actual=${after || 'unknown'} url=${s.page.url?.() ?? ''}`);
    process.exit(1);
  }
  if (visible.id && visible.id !== AD_ACCOUNT_ID) {
    console.log(`FAIL: Meta visible account mismatch; expected=${AD_ACCOUNT_ID} actual=${visible.id} label=${visible.label || ''}`);
    process.exit(1);
  }
  if (AD_ACCOUNT_NAME && visible.label && !visible.label.toLowerCase().includes(AD_ACCOUNT_NAME.toLowerCase())) {
    console.log(`FAIL: Meta visible account name mismatch; expected contains=${AD_ACCOUNT_NAME} label=${visible.label}`);
    process.exit(1);
  }
  return after;
}

const targetUrl = ADS_URL || (AD_ACCOUNT_ID
  ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?${new URLSearchParams({ act: AD_ACCOUNT_ID, ...(BUSINESS_ID ? { business_id: BUSINESS_ID } : {}) })}`
  : 'https://adsmanager.facebook.com/adsmanager/manage/campaigns');
console.log(`[meta-ads] profile=${USER_DATA_DIR} viewport=${process.env.WELES_VIEWPORT}`);
const s = await WSession.start({ label: 'meta_ads_campaign', browser: process.env.BROWSER || 'chromium', proxy: process.env.PROXY_URL || session.proxyUrl || 'direct', persona: profilePersona, userDataDir: USER_DATA_DIR, pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1' });
try {
  await bringBrowserToFront(s);
  await s.goto(targetUrl);
  await s.wait(10);
  let url = s.page.url?.() ?? '';
  if (isLoginUrl(url)) {
    if (!WAIT_FOR_LOGIN) {
      console.log(`FAIL: facebook session expired or checkpointed (${url})`);
      process.exit(2);
    }
    console.log(`[meta-ads] waiting for manual login, deadline=${LOGIN_WAIT_MS}ms`);
    await bringBrowserToFront(s);
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      await s.wait(3);
      url = s.page.url?.() ?? '';
      if (!isLoginUrl(url)) break;
    }
    if (isLoginUrl(url)) {
      console.log(`FAIL: manual login did not complete (${url})`);
      process.exit(2);
    }
    await s.goto(targetUrl);
    await s.wait(8);
  }
  if (/business\.facebook\.com\/security|two_factor|checkpoint/i.test(await pageText(s))) {
    console.log('FAIL: Meta account requires security verification');
    process.exit(2);
  }

  await ensureAdAccount(s);
  if (VERIFY_ACCOUNT_ONLY) {
    const visible = await visibleSelectedAdAccount(s);
    console.log(`PASS: Meta Ads account verified (${visible.label || AD_ACCOUNT_ID || 'unknown'})`);
    process.exit(0);
  }
  await closeObstructingPanels(s);

  await clickAny(s, [
    'button:has-text("I Accept")',
    'button:has-text("Accept")',
    'button:has-text("Akceptuję")',
    'button:has-text("Zgadzam się")',
    'div[role="button"]:has-text("I Accept")',
    'div[role="button"]:has-text("Akceptuję")',
  ], 'policy modal accept', 4000);
  await s.wait(2);

  const startingDraftUrl = s.page.url?.() ?? '';
  let createClicked = /\/edit\/standalone/i.test(startingDraftUrl) && !!selectedCampaignId(startingDraftUrl);
  if (createClicked) {
    console.log(`[meta-ads] configuring existing draft campaign_id=${selectedCampaignId(startingDraftUrl)}`);
  }
  if (!createClicked) createClicked = await clickAny(s, [
    'div[role="toolbar"] div[role="button"]:has-text("Create")',
    'div[role="toolbar"] div[role="button"]:has-text("Utwórz")',
    'div[role="toolbar"] button:has-text("Create")',
    'div[role="toolbar"] button:has-text("Utwórz")',
  ], 'campaign Create', 8000) || await clickVisibleTextInArea(s, /^(\+ )?(Create|Utwórz)$/i, 'campaign Create', {
    minX: 40,
    maxX: 220,
    minY: 120,
    maxY: 230,
    minW: 80,
    minH: 35,
  }, 8000) || await clickAny(s, [
    'div[role="button"]:has-text("Create")',
    'div[role="button"]:has-text("Utwórz")',
    'button:has-text("Create")',
    'button:has-text("Utwórz")',
    '[aria-label="Create"]',
    '[aria-label="Utwórz"]',
  ], 'Create', 12000);
  if (!createClicked) {
    createClicked = await clickPoint(s, 122, 233, 'campaign Create fallback');
    await s.wait(4);
  }

  if (!/\/edit\/standalone/i.test(s.page.url?.() ?? '')) {
    let objectiveClicked = false;
    for (const label of objectiveLabels) {
      if (await clickAny(s, [
        `div[role="radio"]:has-text("${label}")`,
        `label:has-text("${label}")`,
        `div[role="button"]:has-text("${label}")`,
        `div[role="dialog"] div:has-text("${label}")`,
        `text="${label}"`,
      ], `objective ${label}`, 3000)) {
        objectiveClicked = true;
        break;
      }
      if (await clickVisibleTextInArea(s, new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), `objective ${label}`, {
        minX: 250,
        maxX: 700,
        minY: 260,
        maxY: 650,
        minW: 20,
        minH: 12,
      }, 2000)) {
        objectiveClicked = true;
        break;
      }
    }
    if (!objectiveClicked) {
      const viewport = s.page.viewportSize?.() || { width: 1280, height: 900 };
      await clickPoint(s, Math.round(viewport.width * 0.36), 455, 'objective Traffic/Ruch fallback');
      await s.wait(1);
      objectiveClicked = true;
    }
    if (!objectiveClicked) console.log(`[meta-ads] WARN: objective not selected: ${objectiveLabels.join('/')}`);
    await clickAny(s, ['div[role="button"]:has-text("Continue")', 'button:has-text("Continue")'], 'Continue', 5000);
    const continued = await clickAny(s, ['div[role="button"]:has-text("Kontynuuj")', 'button:has-text("Kontynuuj")'], 'Kontynuuj', 5000);
    if (!continued) {
      const viewport = s.page.viewportSize?.() || { width: 1280, height: 900 };
      await clickPoint(s, Math.round(viewport.width * 0.68), 785, 'Kontynuuj fallback');
      await s.wait(4);
    }
    await maybeContinueCampaignConfiguration(s);
  }

  let filledCount = 0;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Campaign name" i]',
    'input[placeholder*="Campaign name" i]',
    'input[placeholder="Wprowadź tutaj nazwę kampanii..."]',
    'label:has-text("Campaign name") input',
  ], CAMPAIGN_NAME, 'campaign name')) filledCount += 1;
  if (await clickNext(s, 3000)) await s.wait(3);
  if (await fillAnyReliable(s, [
    'input[aria-label*="Ad set name" i]',
    'input[placeholder*="Ad set name" i]',
    'input[placeholder="Wprowadź tutaj nazwę zestawu reklam..."]',
  ], AD_SET_NAME, 'ad set name')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Budget" i]',
    'input[placeholder*="Budget" i]',
    'label:has-text("Daily budget") input',
  ], DAILY_BUDGET_USD, 'daily budget')) filledCount += 1;
  if (await clickNext(s, 3000)) await s.wait(3);
  if (await fillAnyReliable(s, [
    'input[aria-label*="Ad name" i]',
    'input[placeholder*="Ad name" i]',
    'input[placeholder="Wprowadź tutaj nazwę reklamy..."]',
  ], AD_NAME, 'ad name')) filledCount += 1;
  if (await selectFacebookPage(s)) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Website URL" i]',
    'input[placeholder*="Website URL" i]',
    'input[placeholder="http://www.przyklad.com/strona"]',
    'input[aria-label*="URL" i]',
  ], DESTINATION_URL, 'destination URL')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Display link" i]',
    'input[placeholder*="Display link" i]',
    'input[placeholder="Wprowadź link, który ma być wyświetlany w reklamie"]',
  ], DISPLAY_LINK, 'display link')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="URL parameters" i]',
    'input[placeholder*="URL parameters" i]',
    'input[placeholder="klucz1=wartość1&klucz2=wartość2"]',
  ], URL_PARAMS, 'URL params')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'textarea[aria-label*="Primary text" i]',
    'div[contenteditable="true"][aria-label*="Primary text" i]',
    'textarea',
  ], PRIMARY_TEXT, 'primary text')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Headline" i]',
    'textarea[aria-label*="Headline" i]',
  ], HEADLINE, 'headline')) filledCount += 1;
  if (await fillAnyReliable(s, [
    'input[aria-label*="Description" i]',
    'textarea[aria-label*="Description" i]',
  ], DESCRIPTION, 'description')) filledCount += 1;

  if (!createClicked || filledCount === 0) {
    const url = s.page.url?.() ?? '';
    const draftCampaignId = selectedCampaignId(url);
    const draftText = await pageText(s);
    if (createClicked && draftCampaignId && /Wersja robocza|Draft/i.test(draftText)) {
      console.log(`PASS: staged Meta ads campaign draft "${CAMPAIGN_NAME}" (SUBMIT=0, campaign_id=${draftCampaignId})`);
      process.exit(0);
    }
    const text = await pageText(s);
    if (/Potrzebne informacje o koncie|Needed account information|Przegląd konta|account review/i.test(text)) {
      console.log(`FAIL: Meta account setup/review blocks campaign draft creation (createClicked=${createClicked}, filled=${filledCount}, url=${s.page.url?.() ?? ''})`);
      process.exit(2);
    }
    console.log(`[meta-ads] visible controls debug: ${JSON.stringify(await visibleControlDebug(s)).slice(0, 6000)}`);
    console.log(`FAIL: Meta Ads campaign form was not reached (createClicked=${createClicked}, filled=${filledCount}, url=${s.page.url?.() ?? ''})`);
    process.exit(1);
  }

  if (!SUBMIT) {
    await verifyConfiguredDraft(s);
    console.log(`PASS: staged Meta ads campaign draft "${CAMPAIGN_NAME}" (SUBMIT=0, filled=${filledCount})`);
    process.exit(0);
  }

  const published = await clickAny(s, [
    'div[role="button"]:has-text("Publish")',
    'button:has-text("Publish")',
    'div[role="button"]:has-text("Confirm")',
  ], 'Publish', 10000);
  if (!published) {
    console.log('FAIL: Publish button not found');
    process.exit(1);
  }
  await s.wait(8);
  const finalText = await pageText(s);
  const status = /published|processing|in review|successfully/i.test(finalText) ? 'confirmed' : 'clicked';
  console.log(`PASS: Meta ads campaign publish ${status} for "${CAMPAIGN_NAME}"`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
