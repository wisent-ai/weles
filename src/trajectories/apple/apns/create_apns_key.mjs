// Create an Apple Push Notifications service (APNs) auth key in the Apple Developer
// portal using the persisted asc-profile session (cookies from the user's earlier
// login). Apple has no API for APNs keys and the user won't do a fresh login, so
// we reuse the saved cookies. Captures the one-time .p8 download. Never closes.
//   node src/trajectories/apple/apns/create_apns_key.mjs
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { setTimeout } from 'node:timers/promises';
import { homedir } from 'node:os';

const ADD_URL = 'https://developer.apple.com/account/resources/authkeys/add';
const OUT_DIR = `${homedir()}/.swiatowid`;
const KEY_NAME = process.env.APNS_KEY_NAME || 'Oko APNs';
const DOWNLOAD_WAIT_MS = 5 * 60 * 1000;

async function clickText(page, rx) {
  for (const loc of [page.getByRole('button', { name: rx }).first(),
                     page.getByRole('link', { name: rx }).first(),
                     page.getByText(rx).first()]) {
    if (await loc.count() > 0) { await humanClickLocator(page, loc); return true; }
  }
  return false;
}

const s = await WSession.start({
  label: 'create_apns_key',
  userDataDir: `${OUT_DIR}/asc-profile`,
  headless: false,
});

await s.goto(ADD_URL);
await setTimeout(6000);
if (/idmsa|\/login|authResult=FAILED/.test(s.page.url())) {
  console.log('NEED_LOGIN: persisted Apple session expired — cannot create the key without a fresh login.');
  console.log('current url:', s.page.url());
} else {
  console.log('[apns] on add page, logged in');
  // Arm the download capture before any clicks, so a flaky selector never loses the key.
  const downloadPromise = s.page.waitForEvent('download', { timeout: DOWNLOAD_WAIT_MS });
  try {
    await s.page.waitForSelector('#name', { state: 'visible' });
    await humanFill(s.page, s.page.locator('#name').first(), KEY_NAME);
    await setTimeout(800);
    // Check the APNs service via its label (trusted event enables Continue).
    const lbl = s.page.locator('label').filter({ hasText: 'Apple Push Notifications service (APNs)' }).first();
    if (await lbl.count() > 0) { await humanClickLocator(s.page, lbl); }
    await setTimeout(1200);
    await clickText(s.page, /^continue$/i);
    await setTimeout(3000);
    await clickText(s.page, /^register$/i);
    await setTimeout(3000);
    const dl = await clickText(s.page, /download/i);
    console.log('[apns] download clicked =', dl);
  } catch (e) {
    console.log('[apns] click flow error (finish in window if needed):', e.message?.slice(0, 140));
  }
  console.log('[apns] waiting for the .p8 download…');
  const download = await downloadPromise;
  const suggested = download.suggestedFilename(); // AuthKey_<KEYID>.p8
  const dest = `${OUT_DIR}/${suggested}`;
  await download.saveAs(dest);
  const keyId = suggested.replace(/^AuthKey_/, '').replace(/\.p8$/, '');
  console.log(`SAVED_P8=${dest}`);
  console.log(`APNS_KEY_ID=${keyId}`);
  console.log('PASS: APNs key downloaded — session left open.');
}
