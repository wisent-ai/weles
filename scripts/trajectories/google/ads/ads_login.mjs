// Google Ads persistent login bootstrap.

import { generatePersona } from '../../../../dist/browser/persona.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 15 * 60 * 1000);
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
  await s.wait(5);
  let cookies = await s.ctx.cookies().catch(() => []);
  if (!hasGoogleAuthCookie(cookies) || isLoginUrl(s.page.url?.() ?? '')) {
    console.log(`[google-ads-login] waiting for manual login, deadline=${LOGIN_WAIT_MS}ms`);
    await bringBrowserToFront(s);
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      await s.wait(3);
      cookies = await s.ctx.cookies().catch(() => []);
      if (hasGoogleAuthCookie(cookies) && !isLoginUrl(s.page.url?.() ?? '')) break;
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
  await s.close().catch(() => {});
}
