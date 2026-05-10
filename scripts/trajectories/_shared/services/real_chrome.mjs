// Launches raw Playwright on real Google Chrome (macOS install). Used for
// provider billing dashboards whose OAuth flow uses GSI storagerelay popup
// postMessage — weles's custom Chromium 147 strips the storagerelay-related
// features so the popup completes but the message never reaches the opener.
// Real Chrome supports the flow natively. No fingerprint risk here since we
// are connecting only to our own providers' billing dashboards.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

// Use Weles Chromium (147), which Google's signin flow recognizes as a
// real Chrome browser (per scripts/trajectories/google/_export_cookies.mjs
// "Uses the custom Weles Chromium so Google doesn't reject with 'This
// browser or app may not be secure'"). Real /Applications/Google Chrome.app
// gets bot-detected even with stealth init scripts; Weles's anti-fingerprint
// patches make it look like a normal user. Combined with launchPersistentContext
// for cookie persistence, this lets the user log into Google ONCE
// (interactively if passkey/2FA, or with stored password) and have all 4
// OAuth-popup providers work non-interactively from there.
const WELES_CHROMIUM = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium';

function profileDir() {
  const dir = join(homedir(), '.weles', 'chrome_profiles', 'service_balance');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function launchRealChrome({ label = 'real_chrome' } = {}) {
  const dir = profileDir();
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: WELES_CHROMIUM,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1366, height: 768 },
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
    try { if (!window.chrome) window.chrome = {}; if (!window.chrome.runtime) window.chrome.runtime = {}; } catch {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch {}
    try {
      const orig = navigator.permissions?.query?.bind(navigator.permissions);
      if (orig) navigator.permissions.query = (p) => p?.name === 'notifications' ? Promise.resolve({ state: Notification.permission, onchange: null }) : orig(p);
    } catch {}
  });
  const page = context.pages()[0] ?? await context.newPage();
  console.log(`[real_chrome] launched (label=${label}, profile=${dir})`);
  return {
    context, page,
    async close() { try { await context.close(); } catch {} },
  };
}

// Drive Google's identifier → password → consent on a real-Chrome page.
export async function googleSsoRealChrome(page, creds) {
  await humanIdlePause('short');
  for (let i = 0; i < 30; i++) {
    if (/accounts\.google\.com/.test(page.url())) break;
    await humanIdlePause('short');
  }
  if (!/accounts\.google\.com/.test(page.url())) {
    console.log(`[google_sso_chrome] FAIL: never reached google (url=${page.url()})`);
    return false;
  }

  const emailIn = page.locator('input[type="email"], input[name="identifier"], input#identifierId').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await emailIn.click();
  await emailIn.pressSequentially(creds.email, { delay: 25 });
  console.log(`[google_sso_chrome] identifier filled (${creds.email})`);
  // Use #identifierNext only; bare [jsname="LgbsSe"] matches hidden audio-captcha button on bot-suspect sessions.
  await page.locator('#identifierNext button, #identifierNext').filter({ visible: true }).first().click();

  let pwInVisible = 0;
  for (let step = 0; step < 6; step++) {
    for (let i = 0; i < 8; i++) {
      await humanIdlePause('short');
      pwInVisible = await page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).count().catch(() => 0);
      if (pwInVisible > 0) break;
    }
    if (pwInVisible > 0) break;
    console.log(`[google_sso_chrome] step=${step} url=${page.url().slice(0, 80)}`);
    // Wait for "Verifying it's you..." overlay to clear before attempting clicks.
    for (let v = 0; v < 30; v++) {
      const verifying = await page.getByText(/Verifying it.s you/i).first().isVisible().catch(() => false);
      if (!verifying) break;
      await humanIdlePause('short');
    }
    const enterPw = page.locator('button:has-text("Enter your password")').filter({ visible: true }).first();
    if (await enterPw.isVisible().catch(() => false)) { console.log('[google_sso_chrome] clicking Enter your password'); await enterPw.click({ force: true }); await humanIdlePause('deliberate'); continue; }
    const tryAnother = page.locator('button:has-text("Try another way")').filter({ visible: true }).first();
    if (await tryAnother.isVisible().catch(() => false)) { console.log('[google_sso_chrome] clicking Try another way'); await tryAnother.click({ force: true }); await humanIdlePause('deliberate'); continue; }
    console.log(`[google_sso_chrome] no progress option visible`); break;
  }
  if (!pwInVisible) { console.log(`[google_sso_chrome] FAIL: never reached password input (final url=${page.url()})`); return false; }

  const pwIn = page.locator('input[type="password"], input[name="Passwd"]').filter({ visible: true }).first();
  await pwIn.click();
  await pwIn.pressSequentially(creds.password, { delay: 25 });
  await page.locator('#passwordNext button, #passwordNext').filter({ visible: true }).first().click();
  return true;
}
