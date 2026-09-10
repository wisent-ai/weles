// Launches raw Playwright on real Google Chrome (macOS install). Used for
// provider billing dashboards whose OAuth flow uses GSI storagerelay popup
// postMessage — weles's custom Chromium 147 strips the storagerelay-related
// features so the popup completes but the message never reaches the opener.
// Real Chrome supports the flow natively. No fingerprint risk here since we
// are connecting only to our own providers' billing dashboards.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { humanIdlePause } from '../../dist/human/mouse.js';
import { runId, runRecordingsDir } from '../../dist/session/run-recordings.js';

// Use Weles Chromium (147), which Google's signin flow recognizes as a
// real Chrome browser (per src/trajectories/google/_export_cookies.mjs
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

/**
 * The two launches that need a genuine Chrome rather than the Weles build,
 * kept here because this file is the reviewed browser boundary and a
 * trajectory that launches Playwright itself is what the boundary check
 * refuses.
 *
 * `launchGenuineChrome` is the signup-grade profile: Chrome's yellow
 * "unsupported command-line flag" bar is what LinkedIn's risk engine reads to
 * reject a signup (screenshots, 2026-05-06), so `--no-sandbox` and
 * `--disable-blink-features=AutomationControlled` are removed from Chrome's own
 * defaults instead of added, and `navigator.webdriver` stays false through
 * `--enable-automation` being ignored.
 */
export async function launchGenuineChrome({
  userDataDir,
  executablePath,
  proxy = null,
  extensionDir = null,
  viewport = { width: 1280, height: 800 },
  extraArgs = [],
} = {}) {
  if (!userDataDir) throw new Error('launchGenuineChrome needs a userDataDir it may own');
  if (!executablePath) throw new Error('launchGenuineChrome needs the real Chrome executablePath');
  const extension = extensionDir && existsSync(extensionDir)
    ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    : [];
  return chromium.launchPersistentContext(userDataDir, {
    executablePath,
    channel: 'chrome',
    headless: false,
    viewport,
    args: ['--disable-infobars', ...extension, ...extraArgs],
    ignoreDefaultArgs: [
      '--enable-automation',
      '--disable-breakpad',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    ...(proxy ? { proxy } : {}),
  });
}

/**
 * The operator-assisted profile: a persistent context on a copy of a real
 * Chrome profile, so a provider that trusts a returning visitor keeps trusting
 * one. The argument set is the one those flows were verified with.
 */
export async function launchProfileChrome({
  userDataDir,
  executablePath,
  viewport = { width: 1280, height: 800 },
  args = ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars'],
  ignoreDefaultArgs = ['--enable-automation', '--disable-breakpad'],
  channel = 'chrome',
} = {}) {
  if (!userDataDir) throw new Error('launchProfileChrome needs a userDataDir it may own');
  if (!executablePath) throw new Error('launchProfileChrome needs the browser executablePath');
  return chromium.launchPersistentContext(userDataDir, {
    executablePath,
    ...(channel ? { channel } : {}),
    headless: false,
    viewport,
    args,
    ignoreDefaultArgs,
  });
}

export async function launchRealChrome({ label = 'real_chrome' } = {}) {
  const dir = profileDir();
  const diagnosticsDir = runRecordingsDir('real_chrome', label);
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: WELES_CHROMIUM,
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1366, height: 768 },
    recordVideo: { dir: diagnosticsDir, size: { width: 1280, height: 720 } },
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
  try {
    writeFileSync(join(diagnosticsDir, 'real_chrome_session.json'), JSON.stringify({
      run_id: runId(),
      action: process.env.ACTION || null,
      label,
      profile_dir: dir,
      executable_path: WELES_CHROMIUM,
      launched_at: new Date().toISOString(),
    }, null, 2));
  } catch {}
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
