// Google Ads browser access verifier.
//
// Reuses the persistent Weles Google Ads profile and reports what the logged-in
// browser can see. This is intentionally browser-first so access can be checked
// even when REST credentials are absent or unavailable.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../../dist/browser/persona.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { assertGoogleAdsProfileNotAlreadyOpen, closeAllowedByEnv } from './_profile_guard.mjs';

const SOURCE_USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 0);
const WAIT_FOR_LOGIN = process.env.WAIT_FOR_LOGIN === '1' || LOGIN_WAIT_MS > 0;
const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || process.env.CUSTOMER_ID || '').replace(/\D/g, '');
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
  if (process.env.GOOGLE_VERIFY_USE_PROFILE_CLONE === '0') {
    return { dir: SOURCE_USER_DATA_DIR, cleanup: () => {} };
  }
  const cloneParent = mkdtempSync(join(tmpdir(), 'weles-google-verify-profile-'));
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
  return /accounts\.google\.com|ServiceLogin|signin/i.test(url);
}

function hasGoogleAuthCookie(cookies) {
  const names = new Set(cookies.filter((c) => /google\.com$|\.google\.com$/.test(c.domain || '')).map((c) => c.name));
  return names.has('SID') || names.has('__Secure-1PSID') || names.has('__Secure-3PSID');
}

function targetUrl() {
  if (process.env.ADS_URL) return process.env.ADS_URL;
  const params = new URLSearchParams();
  if (CUSTOMER_ID) params.set('ocid', CUSTOMER_ID);
  const qs = params.toString();
  return `https://ads.google.com/aw/campaigns${qs ? `?${qs}` : ''}`;
}

async function waitForOptionalLogin(s) {
  if (!WAIT_FOR_LOGIN) return;
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    const cookies = await s.ctx.cookies().catch(() => []);
    if (hasGoogleAuthCookie(cookies) && !isLoginUrl(s.page.url?.() ?? '')) return;
    await s.wait(3);
  }
}

assertGoogleAdsProfileNotAlreadyOpen(SOURCE_USER_DATA_DIR, 'google_ads_verify_access');
const preparedProfile = prepareUserDataDir();
console.log(`[google-ads-verify-access] sourceProfile=${SOURCE_USER_DATA_DIR} clonedProfile=${process.env.GOOGLE_VERIFY_USE_PROFILE_CLONE !== '0'} customer=${CUSTOMER_ID || 'auto'}`);
const s = await WSession.start({
  label: 'google_ads_verify_access',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: preparedProfile.dir,
  headless: process.env.GOOGLE_VERIFY_HEADLESS !== '0',
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
  const loggedIn = hasGoogleAuthCookie(cookies) && !isLoginUrl(current);
  if (!loggedIn) {
    console.log(JSON.stringify({ platform: 'google_ads', loggedIn, url: current }, null, 2));
    console.log(`FAIL: Google Ads browser session is not logged in (${current})`);
    exitCode = 2;
  } else {
    const details = await s.page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const rows = Array.from(document.querySelectorAll('[role="row"], material-list-item, tr'))
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
        empty: /No campaigns|No results|There are no campaigns|Nie ma kampanii/i.test(bodyText),
        accountHints: Array.from(new Set((bodyText.match(/\b\d{3}[-\s]?\d{3}[-\s]?\d{4}\b/g) || []).map((m) => m.replace(/\D/g, '')))).slice(0, 20),
      };
    }).catch(() => ({ title: null, headings: [], rows: [], empty: false, accountHints: [] }));

    let selectedCustomer = CUSTOMER_ID || null;
    try {
      const parsed = new URL(current);
      selectedCustomer = selectedCustomer || parsed.searchParams.get('ocid') || parsed.searchParams.get('customerId');
    } catch {
      selectedCustomer = selectedCustomer || null;
    }

    console.log(JSON.stringify({
      platform: 'google_ads',
      loggedIn,
      selectedCustomer,
      url: current,
      ...details,
    }, null, 2).slice(0, 14000));
    console.log('PASS: Google Ads browser access verified');
  }
} finally {
  if (preparedProfile.dir !== SOURCE_USER_DATA_DIR || closeAllowedByEnv('GOOGLE_VERIFY_CLOSE_AFTER')) await s.close().catch(() => {});
  else console.log('[google-ads-verify-access] leaving Google Ads profile open');
  preparedProfile.cleanup();
}

if (exitCode) process.exit(exitCode);
