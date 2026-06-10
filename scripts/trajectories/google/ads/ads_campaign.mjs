// Google Ads: create/fill a campaign draft in the browser.
//
// Env:
//   GOOGLE_ADS_CUSTOMER_ID required unless ADS_URL is set
//   ADS_URL                optional direct Google Ads campaign creation URL
//   CAMPAIGN_NAME          optional, defaults to timestamped name
//   CAMPAIGN_TYPE          optional label, e.g. Search, Display, Performance Max
//   CAMPAIGN_OBJECTIVE     optional objective label, e.g. Website traffic
//   DAILY_BUDGET_USD       optional daily budget
//   FINAL_URL              optional landing page URL
//   HEADLINE               optional ad headline
//   DESCRIPTION            optional ad description
//   KEYWORDS               optional comma-separated search keywords
//   LOCATIONS              optional comma-separated location names
//   SUBMIT                 must be "1" to publish. Default stages only.
//   PROXY_URL              optional proxy override
//
// Requires a logged-in google account cookie jar. Run google login/register
// flow first when the session is stale.

import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { generatePersona } from '../../../../dist/browser/persona.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../../dist/human/keyboard.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ADS_URL = process.env.ADS_URL;
const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID;
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME || `Wisent ${new Date().toISOString().slice(0, 19)}`;
const CAMPAIGN_TYPE = process.env.CAMPAIGN_TYPE || 'Search';
const CAMPAIGN_OBJECTIVE = process.env.CAMPAIGN_OBJECTIVE || 'Website traffic';
const DAILY_BUDGET_USD = process.env.DAILY_BUDGET_USD;
const FINAL_URL = process.env.FINAL_URL || process.env.DESTINATION_URL;
const HEADLINE = process.env.HEADLINE;
const DESCRIPTION = process.env.DESCRIPTION;
const KEYWORDS = process.env.KEYWORDS;
const LOCATIONS = process.env.LOCATIONS;
const SUBMIT = process.env.SUBMIT === '1';
const WAIT_FOR_LOGIN = process.env.WAIT_FOR_LOGIN === '1';
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 10 * 60 * 1000);
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

if (!ADS_URL && !CUSTOMER_ID && !WAIT_FOR_LOGIN) {
  console.log('FAIL: GOOGLE_ADS_CUSTOMER_ID or ADS_URL required');
  process.exit(1);
}

const acct = await getSocialAccount('google');
const session = acct ? await resolveAccountSession(acct) : { proxyUrl: undefined, persona: undefined };
const profilePersona = process.env.ADS_PROFILE_PERSONA === 'account' && session.persona ? session.persona : stableProfilePersona();

async function clickAny(s, selectors, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = s.page.locator(sel).filter({ visible: true }).first();
      if (await withTimeout(loc.isVisible(), 1500, false).catch(() => false)) {
        const clicked = await withTimeout(humanClickLocator(s.page, loc), 5000, false).catch(() => false);
        if (!clicked) {
          console.log(`[google-ads] WARN: click timed out: ${label} (${sel})`);
          continue;
        }
        console.log(`[google-ads] clicked: ${label}`);
        await humanIdlePause('short');
        return true;
      }
    }
    await s.wait(1);
  }
  return false;
}

async function fillAny(s, selectors, value, label) {
  if (!value) return false;
  for (const sel of selectors) {
    const loc = s.page.locator(sel).filter({ visible: true }).first();
    if (await withTimeout(loc.isVisible(), 1500, false).catch(() => false)) {
      const filled = await withTimeout(humanFill(s.page, loc, String(value)), 6000, false).catch(() => false);
      if (!filled) {
        console.log(`[google-ads] WARN: fill timed out: ${label} (${sel})`);
        continue;
      }
      console.log(`[google-ads] filled: ${label}`);
      await humanIdlePause('short');
      return true;
    }
  }
  console.log(`[google-ads] WARN: field not found: ${label}`);
  return false;
}

async function typeListIntoFirstVisible(s, selectors, csv, label) {
  if (!csv) return false;
  const values = csv.split(',').map((v) => v.trim()).filter(Boolean);
  if (!values.length) return false;
  for (const sel of selectors) {
    const loc = s.page.locator(sel).filter({ visible: true }).first();
    if (!(await withTimeout(loc.isVisible(), 1500, false).catch(() => false))) continue;
    const clicked = await withTimeout(humanClickLocator(s.page, loc), 5000, false).catch(() => false);
    if (!clicked) continue;
    for (const value of values) {
      await humanType(s.page, value);
      await s.page.keyboard.press('Enter');
      await humanIdlePause('short');
    }
    console.log(`[google-ads] entered: ${label} (${values.length})`);
    return true;
  }
  console.log(`[google-ads] WARN: list field not found: ${label}`);
  return false;
}

async function pageText(s) {
  return await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
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
  return /accounts\.google\.com|ServiceLogin|signin/i.test(url);
}

function normalizeCustomerId(id) {
  return id ? String(id).replace(/\D/g, '') : null;
}

function currentCustomerId(url) {
  try {
    const u = new URL(url);
    return normalizeCustomerId(u.searchParams.get('ocid') || u.searchParams.get('customerId') || u.searchParams.get('authuser'));
  } catch {
    return null;
  }
}

async function ensureCustomer(s) {
  const target = normalizeCustomerId(CUSTOMER_ID);
  const before = currentCustomerId(s.page.url?.() ?? '');
  console.log(`[google-ads] current customer=${before || 'unknown'} target=${target || 'unspecified'}`);
  if (!target) return before;
  if (before === target) return before;

  const switchUrl = `https://ads.google.com/aw/campaigns?ocid=${encodeURIComponent(target)}`;
  console.log(`[google-ads] switching customer -> ${target}`);
  await s.goto(switchUrl);
  await s.wait(8);
  const after = currentCustomerId(s.page.url?.() ?? '');
  console.log(`[google-ads] customer after switch=${after || 'unknown'}`);
  if (after && after !== target) {
    console.log(`FAIL: wrong Google Ads customer selected; expected=${target} actual=${after} url=${s.page.url?.() ?? ''}`);
    process.exit(1);
  }
  return after;
}

const baseUrl = ADS_URL || (CUSTOMER_ID
  ? `https://ads.google.com/aw/campaigns/new?ocid=${encodeURIComponent(CUSTOMER_ID)}`
  : 'https://ads.google.com/aw/campaigns');
console.log(`[google-ads] profile=${USER_DATA_DIR} viewport=${process.env.WELES_VIEWPORT}`);
const s = await WSession.start({ label: 'google_ads_campaign', browser: process.env.BROWSER || 'chromium', proxy: process.env.PROXY_URL || session.proxyUrl || 'direct', persona: profilePersona, userDataDir: USER_DATA_DIR });
try {
  await bringBrowserToFront(s);
  await s.goto(baseUrl);
  await s.wait(10);
  let url = s.page.url?.() ?? '';
  if (isLoginUrl(url)) {
    if (!WAIT_FOR_LOGIN) {
      console.log('FAIL: google session expired / not logged in');
      process.exit(2);
    }
    console.log(`[google-ads] waiting for manual login, deadline=${LOGIN_WAIT_MS}ms`);
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
    await s.goto(baseUrl);
    await s.wait(8);
  }

  await ensureCustomer(s);

  const newCampaignClicked = await clickAny(s, [
    'button:has-text("New campaign")',
    'material-button:has-text("New campaign")',
    '[aria-label*="New campaign" i]',
  ], 'New campaign', 12000);
  await clickAny(s, [
    `div[role="radio"]:has-text("${CAMPAIGN_OBJECTIVE}")`,
    `button:has-text("${CAMPAIGN_OBJECTIVE}")`,
    `text="${CAMPAIGN_OBJECTIVE}"`,
  ], `objective ${CAMPAIGN_OBJECTIVE}`, 8000);
  await clickAny(s, [
    `div[role="radio"]:has-text("${CAMPAIGN_TYPE}")`,
    `button:has-text("${CAMPAIGN_TYPE}")`,
    `text="${CAMPAIGN_TYPE}"`,
  ], `campaign type ${CAMPAIGN_TYPE}`, 8000);
  await clickAny(s, ['button:has-text("Continue")', 'material-button:has-text("Continue")'], 'Continue', 6000);

  let filledCount = 0;
  if (await fillAny(s, [
    'input[aria-label*="Campaign name" i]',
    'input[placeholder*="Campaign name" i]',
    'label:has-text("Campaign name") input',
  ], CAMPAIGN_NAME, 'campaign name')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Budget" i]',
    'input[placeholder*="Budget" i]',
    'label:has-text("Budget") input',
  ], DAILY_BUDGET_USD, 'daily budget')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Final URL" i]',
    'input[aria-label*="Website" i]',
    'input[placeholder*="URL" i]',
  ], FINAL_URL, 'final URL')) filledCount += 1;
  if (await typeListIntoFirstVisible(s, [
    'input[aria-label*="location" i]',
    'input[placeholder*="location" i]',
  ], LOCATIONS, 'locations')) filledCount += 1;
  if (await typeListIntoFirstVisible(s, [
    'textarea[aria-label*="keyword" i]',
    'input[aria-label*="keyword" i]',
    'textarea[placeholder*="keyword" i]',
  ], KEYWORDS, 'keywords')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Headline" i]',
    'textarea[aria-label*="Headline" i]',
  ], HEADLINE, 'headline')) filledCount += 1;
  if (await fillAny(s, [
    'textarea[aria-label*="Description" i]',
    'input[aria-label*="Description" i]',
  ], DESCRIPTION, 'description')) filledCount += 1;

  await clickAny(s, ['button:has-text("Save and continue")', 'button:has-text("Next")'], 'Save and continue', 5000);

  if (!newCampaignClicked || filledCount === 0) {
    console.log(`FAIL: Google Ads campaign form was not reached (newCampaignClicked=${newCampaignClicked}, filled=${filledCount}, url=${s.page.url?.() ?? ''})`);
    process.exit(1);
  }

  if (!SUBMIT) {
    console.log(`PASS: staged Google Ads campaign draft "${CAMPAIGN_NAME}" (SUBMIT=0, filled=${filledCount})`);
    process.exit(0);
  }

  const published = await clickAny(s, [
    'button:has-text("Publish campaign")',
    'button:has-text("Publish")',
    'button:has-text("Submit")',
  ], 'Publish campaign', 10000);
  if (!published) {
    console.log('FAIL: Publish campaign button not found');
    process.exit(1);
  }
  await s.wait(8);
  const finalText = await pageText(s);
  const status = /published|eligible|under review|campaign has been created|success/i.test(finalText) ? 'confirmed' : 'clicked';
  console.log(`PASS: Google Ads campaign publish ${status} for "${CAMPAIGN_NAME}"`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
