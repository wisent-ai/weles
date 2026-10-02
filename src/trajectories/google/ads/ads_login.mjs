import { pageSettled } from '../../_shared/page/settled.mjs';
// Google Ads persistent login bootstrap.

import { generatePersona } from '../../../../dist/browser/persona.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso } from '../../_shared/services/google_sso.mjs';
import { dismissGooglePostLogin } from '../../_shared/services/google_sso/sign_in/redirect_watch.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertGoogleAdsProfileNotAlreadyOpen, closeAllowedByEnv } from './_profile_guard.mjs';
import { readScopedLogin } from '../../../_shared/scoped-secrets.mjs';

const ALLOW_MANUAL_LOGIN = process.env.ALLOW_MANUAL_LOGIN === '1' || process.env.WAIT_FOR_LOGIN === '1';
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
const GOOGLE_ADS_LOGIN = readScopedLogin('googleAds');
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';


async function resolveSsoCreds() {
  return { ...GOOGLE_ADS_LOGIN, source: 'skarbiec' };
}

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
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

function hasGoogleAuthCookie(cookies) {
  const names = new Set(cookies.filter((c) => /google\.com$|\.google\.com$/.test(c.domain || '')).map((c) => c.name));
  return names.has('SID') || names.has('__Secure-1PSID') || names.has('__Secure-3PSID');
}

console.log(`[google-ads-login] profile=${USER_DATA_DIR} viewport=${process.env.WELES_VIEWPORT}`);
assertGoogleAdsProfileNotAlreadyOpen(USER_DATA_DIR, 'google_ads_login');
const s = await WSession.start({
  label: 'google_ads_login',
  browser: 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
});

try {
  await bringBrowserToFront(s);
  await s.goto('https://ads.google.com/aw/campaigns');
  await pageSettled(s.page);
  let cookies = await s.ctx.cookies().catch(() => []);
  if (!hasGoogleAuthCookie(cookies) || isLoginUrl(s.page.url?.() ?? '')) {
    const creds = await resolveSsoCreds();
    if (creds) {
      console.log(`[google-ads-login] running automated Google SSO for ${creds.email} source=${creds.source || 'unknown'}`);
      const ok = await googleSso(s, creds);
      if (!ok) {
        console.log(`FAIL: automated Google SSO did not complete (url=${s.page.url?.() ?? ''})`);
        process.exit(2);
      }
      await dismissGooglePostLogin(s.page);
      await s.goto('https://ads.google.com/aw/campaigns');
      await pageSettled(s.page);
    } else if (ALLOW_MANUAL_LOGIN) {
      console.log('[google-ads-login] waiting for manual login in the open window');
      await bringBrowserToFront(s);
      await s.page.waitForURL((u) => !isLoginUrl(String(u)));
      await pageSettled(s.page);
    } else {
      console.log('FAIL: Google Ads browser session is logged out and no SSO credentials are available');
      process.exit(2);
    }
  }
  cookies = await s.ctx.cookies().catch(() => []);
  const names = cookies.filter((c) => /google\.com$|\.google\.com$/.test(c.domain || '')).map((c) => c.name).sort();
  console.log(`[google-ads-login] cookie names: ${Array.from(new Set(names)).join(', ')}`);
  if (!hasGoogleAuthCookie(cookies)) {
    console.log(`FAIL: login not persisted; missing Google auth cookies (url=${s.page.url?.() ?? ''})`);
    process.exit(2);
  }
  console.log('PASS: Google Ads login persisted');
} finally {
  if (closeAllowedByEnv('GOOGLE_ADS_LOGIN_CLOSE_AFTER')) await s.close().catch(() => {});
  else console.log('[google-ads-login] leaving Google Ads profile open');
}
