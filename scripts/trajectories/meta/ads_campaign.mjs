// Meta Ads Manager: create/fill a campaign draft in the browser.
//
// Env:
//   AD_ACCOUNT_ID        required unless ADS_URL is set; numeric or act_<id>
//   ADS_URL              optional direct Ads Manager creation URL
//   CAMPAIGN_NAME        optional, defaults to timestamped name
//   CAMPAIGN_OBJECTIVE   optional objective label text, e.g. Traffic, Leads
//   DAILY_BUDGET_USD     optional daily budget
//   DESTINATION_URL      optional landing page URL
//   PRIMARY_TEXT         optional ad primary text
//   HEADLINE             optional ad headline
//   DESCRIPTION          optional ad description
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
const RAW_AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID;
const AD_ACCOUNT_ID = RAW_AD_ACCOUNT_ID?.replace(/^act_/, '');
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME || `Wisent ${new Date().toISOString().slice(0, 19)}`;
const CAMPAIGN_OBJECTIVE = process.env.CAMPAIGN_OBJECTIVE || 'Traffic';
const DAILY_BUDGET_USD = process.env.DAILY_BUDGET_USD;
const DESTINATION_URL = process.env.DESTINATION_URL || process.env.FINAL_URL;
const PRIMARY_TEXT = process.env.PRIMARY_TEXT;
const HEADLINE = process.env.HEADLINE;
const DESCRIPTION = process.env.DESCRIPTION;
const SUBMIT = process.env.SUBMIT === '1';
const WAIT_FOR_LOGIN = process.env.WAIT_FOR_LOGIN === '1';
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 10 * 60 * 1000);
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

if (!ADS_URL && !AD_ACCOUNT_ID && !WAIT_FOR_LOGIN) {
  console.log('FAIL: AD_ACCOUNT_ID or ADS_URL required');
  process.exit(1);
}

const acct = await getSocialAccount('facebook');
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
          console.log(`[meta-ads] WARN: click timed out: ${label} (${sel})`);
          continue;
        }
        console.log(`[meta-ads] clicked: ${label}`);
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

async function ensureAdAccount(s) {
  const before = currentAdAccountId(s.page.url?.() ?? '');
  console.log(`[meta-ads] current ad account=${before || 'unknown'} target=${AD_ACCOUNT_ID || 'unspecified'}`);
  if (!AD_ACCOUNT_ID) return before;
  if (before === AD_ACCOUNT_ID) return before;

  const switchUrl = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${AD_ACCOUNT_ID}`;
  console.log(`[meta-ads] switching ad account -> ${AD_ACCOUNT_ID}`);
  await s.goto(switchUrl);
  await s.wait(8);
  const after = currentAdAccountId(s.page.url?.() ?? '');
  console.log(`[meta-ads] ad account after switch=${after || 'unknown'}`);
  if (after !== AD_ACCOUNT_ID) {
    console.log(`FAIL: wrong Meta ad account selected; expected=${AD_ACCOUNT_ID} actual=${after || 'unknown'} url=${s.page.url?.() ?? ''}`);
    process.exit(1);
  }
  return after;
}

const targetUrl = ADS_URL || (AD_ACCOUNT_ID
  ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${AD_ACCOUNT_ID}`
  : 'https://adsmanager.facebook.com/adsmanager/manage/campaigns');
console.log(`[meta-ads] profile=${USER_DATA_DIR} viewport=${process.env.WELES_VIEWPORT}`);
const s = await WSession.start({ label: 'meta_ads_campaign', browser: process.env.BROWSER || 'chromium', proxy: process.env.PROXY_URL || session.proxyUrl || 'direct', persona: profilePersona, userDataDir: USER_DATA_DIR });
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

  await clickAny(s, [
    'button:has-text("I Accept")',
    'button:has-text("Accept")',
    'button:has-text("Akceptuję")',
    'button:has-text("Zgadzam się")',
    'div[role="button"]:has-text("I Accept")',
    'div[role="button"]:has-text("Akceptuję")',
  ], 'policy modal accept', 4000);
  await s.wait(2);

  const createClicked = await clickAny(s, [
    'div[role="button"]:has-text("Create")',
    'div[role="button"]:has-text("Utwórz")',
    'button:has-text("Create")',
    'button:has-text("Utwórz")',
    '[aria-label="Create"]',
    '[aria-label="Utwórz"]',
  ], 'Create', 12000);

  await clickAny(s, [
    `div[role="radio"]:has-text("${CAMPAIGN_OBJECTIVE}")`,
    `label:has-text("${CAMPAIGN_OBJECTIVE}")`,
    `div[role="button"]:has-text("${CAMPAIGN_OBJECTIVE}")`,
    `text="${CAMPAIGN_OBJECTIVE}"`,
  ], `objective ${CAMPAIGN_OBJECTIVE}`, 8000);
  await clickAny(s, ['div[role="button"]:has-text("Continue")', 'button:has-text("Continue")'], 'Continue', 5000);

  let filledCount = 0;
  if (await fillAny(s, [
    'input[aria-label*="Campaign name" i]',
    'input[placeholder*="Campaign name" i]',
    'label:has-text("Campaign name") input',
  ], CAMPAIGN_NAME, 'campaign name')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Budget" i]',
    'input[placeholder*="Budget" i]',
    'label:has-text("Daily budget") input',
  ], DAILY_BUDGET_USD, 'daily budget')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Website URL" i]',
    'input[placeholder*="Website URL" i]',
    'input[aria-label*="URL" i]',
  ], DESTINATION_URL, 'destination URL')) filledCount += 1;
  if (await fillAny(s, [
    'textarea[aria-label*="Primary text" i]',
    'div[contenteditable="true"][aria-label*="Primary text" i]',
    'textarea',
  ], PRIMARY_TEXT, 'primary text')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Headline" i]',
    'textarea[aria-label*="Headline" i]',
  ], HEADLINE, 'headline')) filledCount += 1;
  if (await fillAny(s, [
    'input[aria-label*="Description" i]',
    'textarea[aria-label*="Description" i]',
  ], DESCRIPTION, 'description')) filledCount += 1;

  if (!createClicked || filledCount === 0) {
    console.log(`FAIL: Meta Ads campaign form was not reached (createClicked=${createClicked}, filled=${filledCount}, url=${s.page.url?.() ?? ''})`);
    process.exit(1);
  }

  if (!SUBMIT) {
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
