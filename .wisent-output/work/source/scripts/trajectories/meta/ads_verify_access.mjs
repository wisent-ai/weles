// Meta Ads browser access verifier.
//
// Reuses the persistent Weles Meta Ads profile and reports the selected account
// plus visible campaign rows. This path does not require a Marketing API token.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const SOURCE_USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 0);
const WAIT_FOR_LOGIN = process.env.WAIT_FOR_LOGIN === '1' || LOGIN_WAIT_MS > 0;
const AD_ACCOUNT_ID = (process.env.AD_ACCOUNT_ID || process.env.META_ADS_COMPANY_ACCOUNT_ID || '').replace(/^act_/, '');
const BUSINESS_ID = process.env.BUSINESS_ID || process.env.META_BUSINESS_ID || '';
const AD_ACCOUNT_NAME = process.env.AD_ACCOUNT_NAME || process.env.META_ADS_ACCOUNT_NAME || '';
mkdirSync(SOURCE_USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';

function stableProfilePersona() {
  const p = join(SOURCE_USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function profileCopyFilter(src) {
  const base = src.split('/').pop() || '';
  if (/^Singleton/.test(base)) return false;
  if ([
    'Crashpad',
    'Crash Reports',
    'Cache',
    'Code Cache',
    'GPUCache',
    'ShaderCache',
    'GrShaderCache',
    'GraphiteDawnCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'Safe Browsing',
    'optimization_guide_model_store',
    'component_crx_cache',
    'extensions_crx_cache',
  ].includes(base)) return false;
  return true;
}

function prepareUserDataDir() {
  if (process.env.META_VERIFY_USE_PROFILE_CLONE === '0') {
    return { dir: SOURCE_USER_DATA_DIR, cleanup: () => {} };
  }
  const cloneParent = mkdtempSync(join(tmpdir(), 'weles-meta-verify-profile-'));
  const cloneDir = join(cloneParent, 'profile');
  cpSync(SOURCE_USER_DATA_DIR, cloneDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: profileCopyFilter,
  });
  return {
    dir: cloneDir,
    cleanup: () => rmSync(cloneParent, { recursive: true, force: true }),
  };
}

function isLoginUrl(url) {
  return /facebook\.com\/login|business\.facebook\.com\/business\/loginpage|checkpoint|recover/i.test(url);
}

function hasMetaAuthCookie(cookies) {
  const names = new Set(cookies.filter((c) => /facebook\.com|business\.facebook\.com/.test(c.domain || '')).map((c) => c.name));
  return names.has('c_user') && names.has('xs');
}

function targetUrl() {
  if (process.env.ADS_URL) return process.env.ADS_URL;
  const params = new URLSearchParams();
  if (AD_ACCOUNT_ID) params.set('act', AD_ACCOUNT_ID);
  if (BUSINESS_ID) params.set('business_id', BUSINESS_ID);
  const qs = params.toString();
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns${qs ? `?${qs}` : ''}`;
}

async function waitForOptionalLogin(s) {
  if (!WAIT_FOR_LOGIN) return;
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    const cookies = await s.ctx.cookies().catch(() => []);
    if (hasMetaAuthCookie(cookies) && !isLoginUrl(s.page.url?.() ?? '')) return;
    await s.wait(3);
  }
}

const preparedProfile = prepareUserDataDir();
console.log(`[meta-ads-verify-access] sourceProfile=${SOURCE_USER_DATA_DIR} clonedProfile=${process.env.META_VERIFY_USE_PROFILE_CLONE !== '0'} account=${AD_ACCOUNT_ID || 'auto'}`);
const s = await WSession.start({
  label: 'meta_ads_verify_access',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: preparedProfile.dir,
  headless: process.env.META_VERIFY_HEADLESS !== '0',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  await s.goto(targetUrl());
  await s.wait(8);
  await waitForOptionalLogin(s);
  await s.wait(2);

  const current = s.page.url?.() ?? '';
  const cookies = await s.ctx.cookies().catch(() => []);
  const text = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const loggedIn = hasMetaAuthCookie(cookies) && !isLoginUrl(current);
  if (!loggedIn) {
    console.log(JSON.stringify({ platform: 'meta_ads', loggedIn, url: current }, null, 2));
    console.log(`FAIL: Meta Ads browser session is not logged in (${current})`);
    exitCode = 2;
  } else {
    const details = await s.page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const visibleAccount = bodyText.match(/([^\n]*\((\d{6,})\))/);
      const rows = Array.from(document.querySelectorAll('[role="row"], tr'))
        .map((row) => (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 80);
      const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
        .map((node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 20);
      return {
        title: document.title || null,
        headings,
        rows,
        empty: /Brak wyników|No results|Nie utworzono|No campaigns/i.test(bodyText),
        visibleAccountLabel: visibleAccount?.[1]?.trim() || null,
        visibleAccountId: visibleAccount?.[2] || null,
      };
    }).catch(() => ({ title: null, headings: [], rows: [], empty: false, visibleAccountLabel: null, visibleAccountId: null }));

    if (AD_ACCOUNT_ID && details.visibleAccountId && details.visibleAccountId !== AD_ACCOUNT_ID) {
      console.log(JSON.stringify({
        platform: 'meta_ads',
        loggedIn,
        expectedAccountId: AD_ACCOUNT_ID,
        visibleAccountId: details.visibleAccountId,
        visibleAccountLabel: details.visibleAccountLabel,
        url: current,
      }, null, 2));
      console.log('FAIL: wrong Meta ad account selected');
      exitCode = 1;
    } else if (AD_ACCOUNT_NAME && details.visibleAccountLabel && !details.visibleAccountLabel.toLowerCase().includes(AD_ACCOUNT_NAME.toLowerCase())) {
      console.log(JSON.stringify({
        platform: 'meta_ads',
        loggedIn,
        expectedAccountName: AD_ACCOUNT_NAME,
        visibleAccountLabel: details.visibleAccountLabel,
        url: current,
      }, null, 2));
      console.log('FAIL: wrong Meta ad account label');
      exitCode = 1;
    } else {
      console.log(JSON.stringify({
        platform: 'meta_ads',
        loggedIn,
        expectedAccountId: AD_ACCOUNT_ID || null,
        url: current,
        ...details,
      }, null, 2).slice(0, 14000));
      console.log('PASS: Meta Ads browser access verified');
    }
  }
} finally {
  await s.close().catch(() => {});
  preparedProfile.cleanup();
}

if (exitCode) process.exit(exitCode);
