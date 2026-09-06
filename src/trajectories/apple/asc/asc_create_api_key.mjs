// Generate an App Store Connect API key through an already authenticated persistent profile.
// Authentication is delegated exclusively to an explicitly authorized apple_login run.
//
// Usage:
//   node src/trajectories/apple/asc/asc_create_api_key.mjs
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { setTimeout } from 'node:timers/promises';
import { homedir } from 'node:os';

async function requireAuthenticatedSession(s) {
  await s.wait(3);
  const url = s.page.url?.() ?? '';
  const loginUrl = /idmsa\.apple\.com|appleid\.apple\.com|\/login(?:[/?#]|$)|signin/i.test(url);
  const authIframe = await s.page.locator('iframe[src*="idmsa.apple.com"], iframe[src*="appleid.apple.com"]').count() > 0;
  let authPrompt = false;
  for (const frame of s.page.frames()) {
    authPrompt ||= await frame.locator([
      '#account_name_text_field',
      '#password_text_field',
      'input[type="password"]',
      'input[aria-label*="digit"]',
      'input[aria-label*="Digit"]',
      'input[type="tel"][maxlength="1"]',
    ].join(', ')).first().isVisible().catch(() => false);
    authPrompt ||= await frame.getByText(/Two-Factor Authentication|verification code sent to your Apple devices/i).first().isVisible().catch(() => false);
    if (authPrompt) break;
  }
  if (loginUrl || authIframe || authPrompt) {
    throw new Error('FAIL_CLOSED: Apple login/password/2FA is required; this trajectory will not authenticate. An explicitly authorized apple_login is the only permitted login path.');
  }
}

const API_URL = 'https://appstoreconnect.apple.com/access/integrations/api';
const KEY_NAME = process.env.KEY_NAME || 'swiatowid-ios-ci';
const OUT_DIR = `${homedir()}/.swiatowid`;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function requireApiPage(s) {
  await requireAuthenticatedSession(s);
  let parsedUrl = new URL(s.page.url?.() || 'about:blank');
  const authenticatedHost = parsedUrl.hostname === 'appstoreconnect.apple.com' && !/\/login(?:\/|$)|idmsa/i.test(parsedUrl.pathname);
  if (authenticatedHost && !parsedUrl.pathname.startsWith('/access/integrations/api')) {
    await s.goto(API_URL);
    await s.wait(3);
    await requireAuthenticatedSession(s);
    parsedUrl = new URL(s.page.url?.() || 'about:blank');
  }
  if (parsedUrl.hostname !== 'appstoreconnect.apple.com' || !parsedUrl.pathname.startsWith('/access/integrations/api')) {
    throw new Error('FAIL_CLOSED: authenticated App Store Connect API integrations page was not confirmed; run an explicitly authorized apple_login before retrying.');
  }
  console.log(`[asc-create] strona API — ${parsedUrl.href}`);
}

// Best-effort UI clicks. Uses count() gates (which never throw) so a missing
// element is a no-op; a real click error is re-thrown to the caller, which logs
// it and still falls back to the human clicking in the window.
async function clickByText(page, rx) {
  for (const loc of [page.getByRole('button', { name: rx }).first(),
                     page.getByRole('link', { name: rx }).first(),
                     page.getByText(rx).first()]) {
    if (await loc.count() > 0) { await humanClickLocator(page, loc); return true; }
  }
  return false;
}

async function clickGenerate(page) {
  const clickables = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')];
    return [...new Set(els.map(e => (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 60);
  });
  console.log('[asc-create] klikalne na stronie: ' + JSON.stringify(clickables));

  const opened = await clickByText(page, /generate api key|generate team key|generate key|add a key/i);
  console.log('[asc-create] generate-open=' + opened);
  await setTimeout(2000);

  const name = page.getByRole('textbox').first();
  if (await name.count() > 0) { await humanFill(page, name, KEY_NAME); await setTimeout(500); }
  await clickByText(page, /app manager/i);
  await setTimeout(800);
  await clickByText(page, /^\s*generate\s*$|^\s*create\s*$/i);
  await setTimeout(2500);
  const dl = await clickByText(page, /download api key|download/i);
  console.log('[asc-create] download=' + dl);
}

const s = await WSession.start({
  label: 'asc_create_api_key',
  userDataDir: `${OUT_DIR}/asc-profile`,
  headless: false,
});
try {
  await s.goto(API_URL);
  await requireApiPage(s);
  await setTimeout(3000);

  // Arm the download capture FIRST, then attempt the clicks. Whichever path
  // triggers the download (script or human), we save it.
  const downloadPromise = s.page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS });
  try {
    await clickGenerate(s.page);
  } catch (e) {
    console.log('[asc-create] auto-klik nie przeszedł, dokończ w oknie ręcznie:', e.message?.slice(0, 120));
  }

  console.log('[asc-create] czekam na pobranie .p8 (kliknij „Download API Key" jeśli trzeba)…');
  const download = await downloadPromise;
  const suggested = download.suggestedFilename();           // AuthKey_<KEYID>.p8
  const dest = `${OUT_DIR}/${suggested}`;
  await download.saveAs(dest);
  const keyId = suggested.replace(/^AuthKey_/, '').replace(/\.p8$/, '');
  console.log(`SAVED_P8=${dest}`);
  console.log(`KEY_ID=${keyId}`);
  console.log('PASS: API key downloaded — OKNO ZOSTAJE OTWARTE (świadomie nie zamykam sesji).');
  // Deliberately NOT closing: the live, logged-in window stays open so the
  // session is never thrown away again. The .p8 is already saved to disk and the
  // key id is printed above, so the result is captured without tearing down.
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  // No teardown on failure either — leave the window so you can finish manually.
}
