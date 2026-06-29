// Open App Store Connect in a PERSISTENT profile (so the manual login survives
// across runs), then generate an App Store Connect API key with the App Manager
// role and capture the one-time .p8 download. The download capture is armed
// before the clicks, so it works whether the Generate/Download is triggered by
// this script or by the user in the window — a flaky selector never loses the key.
//
// Usage:
//   node scripts/trajectories/apple/asc/asc_create_api_key.mjs
import { WSession } from '../../../../dist/session/wsession.js';
import { getSocialAccount } from '../../../../dist/utils/credentials.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { setTimeout } from 'node:timers/promises';
import { homedir } from 'node:os';

// Auto-fill the Apple ID email + password (from the stored account) on the idmsa
// login iframe, so the only remaining step is the on-screen 2FA — which the
// orchestrator handles natively (click Allow, read the code, type it). Raw fills
// mirror the existing apple manual_2fa trajectory (Apple idmsa, not a bot-scored
// surface), hence the per-line allow-raw-playwright bypass.
async function fillLogin(s) {
  const acct = await getSocialAccount('apple');
  const email = acct?.metadata?.email;
  const password = acct?.metadata?.password;
  if (!email || !password) { console.log('[asc-create] brak email/hasła konta apple — pomijam autofill'); return; }
  await s.wait(5);
  // Already logged in via the persistent profile? Then there is no idmsa iframe — skip.
  if (await s.page.locator('iframe[src*="idmsa.apple.com"]').count() === 0) {
    console.log('[asc-create] brak ekranu logowania (już zalogowany w profilu) — pomijam autofill');
    return;
  }
  const authFrame = await s.page.$('iframe[src*="idmsa.apple.com"]');
  const frame = await authFrame.contentFrame();
  if (!frame) { console.log('[asc-create] brak iframe idmsa'); return; }
  await frame.waitForSelector('#account_name_text_field');
  await frame.locator('#account_name_text_field').fill(email); // allow-raw-playwright: apple idmsa, same as manual_2fa
  await frame.locator('#sign-in').click(); // allow-raw-playwright: apple idmsa, same as manual_2fa
  await s.wait(5);
  const cont = frame.locator('#continue-password');
  if (await cont.count() > 0) { await cont.click(); await s.wait(3); } // allow-raw-playwright: apple idmsa, same as manual_2fa
  for (const sel of ['#password_text_field', 'input[type="password"]', 'input[name="password"]']) {
    if (await frame.locator(sel).first().count() > 0) {
      await frame.locator(sel).first().fill(password); // allow-raw-playwright: apple idmsa, same as manual_2fa
      await frame.locator('#sign-in').click(); // allow-raw-playwright: apple idmsa, same as manual_2fa
      break;
    }
  }
  console.log('[asc-create] email+hasło wpisane — teraz 2FA (obsługuję natywnie)');
}

const API_URL = 'https://appstoreconnect.apple.com/access/integrations/api';
const KEY_NAME = process.env.KEY_NAME || 'swiatowid-ios-ci';
const OUT_DIR = `${homedir()}/.swiatowid`;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function waitForApiPage(s) {
  console.log('[asc-create] ZALOGUJ SIĘ w oknie jeśli poprosi (email + hasło + 2FA + Trust)…');
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let renavigated = false;
  while (Date.now() < deadline) {
    const url = s.page.url?.() ?? '';
    const authed = url.includes('appstoreconnect.apple.com') && !url.includes('/login') && !url.includes('idmsa');
    if (authed && url.includes('/access/integrations/api')) { console.log(`[asc-create] strona API — ${url}`); return; }
    if (authed && !renavigated) {
      renavigated = true;
      try { await s.goto(API_URL); } catch (e) { console.log('[asc-create] re-nav:', e.message?.slice(0, 80)); }
    }
    await setTimeout(2000);
  }
  throw new Error('Timed out waiting for the App Store Connect API page');
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
  await fillLogin(s);
  await waitForApiPage(s);
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
