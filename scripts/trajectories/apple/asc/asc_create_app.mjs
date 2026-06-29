// Create the App Store Connect app record for ai.wisent.swiatowid through the ASC
// web UI, because Apple forbids it via the API (POST /v1/apps -> 403 FORBIDDEN).
// Reuses the apple login autofill + native 2FA pattern from asc_create_api_key.mjs.
// Opens Apps, clicks New App, fills the dialog, clicks Create, then verifies via
// the ASC API. Never closes the session.
//
// Usage:
//   node scripts/trajectories/apple/asc/asc_create_app.mjs
import { WSession } from '../../../../dist/session/wsession.js';
import { getSocialAccount } from '../../../../dist/utils/credentials.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { setTimeout } from 'node:timers/promises';
import { homedir } from 'node:os';
import crypto from 'node:crypto';

const APPS_URL = 'https://appstoreconnect.apple.com/apps';
const OUT_DIR = `${homedir()}/.swiatowid`;
const APP_NAME = process.env.ASC_APP_NAME || 'Swiatowid';
const BUNDLE = process.env.ASC_BUNDLE || 'ai.wisent.swiatowid';
const SKU = process.env.ASC_SKU || 'swiatowidios2026';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

// ---- login autofill (mirrors asc_create_api_key.mjs) ----
async function fillLogin(s) {
  const acct = await getSocialAccount('apple');
  const email = acct?.metadata?.email;
  const password = acct?.metadata?.password;
  if (!email || !password) { console.log('[asc-app] brak konta apple — czekam na ręczne logowanie'); return; }
  await s.wait(5);
  if (await s.page.locator('iframe[src*="idmsa.apple.com"]').count() === 0) {
    console.log('[asc-app] już zalogowany w profilu — pomijam autofill'); return;
  }
  const authFrame = await s.page.$('iframe[src*="idmsa.apple.com"]');
  const frame = await authFrame?.contentFrame();
  if (!frame) { console.log('[asc-app] brak iframe idmsa'); return; }
  await frame.waitForSelector('#account_name_text_field');
  await frame.locator('#account_name_text_field').fill(email); // allow-raw-playwright: apple idmsa
  await frame.locator('#sign-in').click(); // allow-raw-playwright: apple idmsa
  await s.wait(5);
  const cont = frame.locator('#continue-password');
  if (await cont.count() > 0) { await cont.click(); await s.wait(3); } // allow-raw-playwright: apple idmsa
  for (const sel of ['#password_text_field', 'input[type="password"]', 'input[name="password"]']) {
    if (await frame.locator(sel).first().count() > 0) {
      await frame.locator(sel).first().fill(password); // allow-raw-playwright: apple idmsa
      await frame.locator('#sign-in').click(); // allow-raw-playwright: apple idmsa
      break;
    }
  }
  console.log('[asc-app] email+hasło wpisane — 2FA obsługuję natywnie');
}

async function waitForAppsPage(s) {
  console.log('[asc-app] ZALOGUJ SIĘ w oknie jeśli poprosi (email + hasło + 2FA + Trust)…');
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let renavigated = false;
  while (Date.now() < deadline) {
    const url = s.page.url?.() ?? '';
    const authed = url.includes('appstoreconnect.apple.com') && !url.includes('/login') && !url.includes('idmsa');
    if (authed && url.includes('/apps')) { console.log(`[asc-app] strona Apps — ${url}`); return; }
    if (authed && !renavigated) { renavigated = true; try { await s.goto(APPS_URL); } catch (e) { console.log('[asc-app] re-nav:', e.message?.slice(0, 80)); } }
    await setTimeout(2000);
  }
  throw new Error('Timed out waiting for the App Store Connect Apps page');
}

async function clickByText(page, rx, root) {
  const scope = root || page;
  for (const loc of [scope.getByRole('button', { name: rx }).first(),
                     scope.getByRole('menuitem', { name: rx }).first(),
                     scope.getByRole('link', { name: rx }).first(),
                     scope.getByText(rx).first()]) {
    if (await loc.count() > 0) { await humanClickLocator(page, loc); return true; }
  }
  return false;
}

async function isCheckedSafe(loc) {
  try { return await loc.isChecked(); } catch (e) { console.log('[asc-app] isChecked err:', e.message?.slice(0, 60)); return false; }
}

async function dumpClickables(page, tag) {
  const items = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="combobox"], select, input')];
    return [...new Set(els.map(e => (e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.textContent || e.name || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 80);
  });
  console.log(`[asc-app] ${tag}: ` + JSON.stringify(items));
}

async function openNewAppDialog(page) {
  await dumpClickables(page, 'apps-page');
  const opened = await clickByText(page, /^add\b|new app|add app|\+/i);
  console.log('[asc-app] add-clicked=' + opened);
  await setTimeout(1500);
  await clickByText(page, /new app/i);
  await setTimeout(2500);
}

async function fillDialog(page) {
  await dumpClickables(page, 'dialog');
  const ios = page.getByRole('checkbox', { name: /ios/i }).first();
  if (await ios.count() > 0 && !(await isCheckedSafe(ios))) { await humanClickLocator(page, ios); }
  for (const loc of [page.getByLabel(/^name$/i).first(), page.getByPlaceholder(/name/i).first(), page.getByRole('textbox').first()]) {
    if (await loc.count() > 0) { await humanFill(page, loc, APP_NAME); break; }
  }
  await setTimeout(500);
  const lang = page.getByLabel(/primary language/i).first();
  if (await lang.count() > 0) { await humanClickLocator(page, lang); await setTimeout(600); await clickByText(page, /english \(u\.?s\.?\)|english/i); }
  await setTimeout(500);
  const bundle = page.getByLabel(/bundle id/i).first();
  if (await bundle.count() > 0) {
    await humanClickLocator(page, bundle); await setTimeout(600);
    const ok = await clickByText(page, new RegExp(BUNDLE.replace(/\./g, '\\.'), 'i')) || await clickByText(page, new RegExp(BUNDLE.split('.').pop(), 'i'));
    console.log('[asc-app] bundle-picked=' + ok);
  }
  await setTimeout(500);
  for (const loc of [page.getByLabel(/^sku$/i).first(), page.getByPlaceholder(/sku/i).first()]) {
    if (await loc.count() > 0) { await humanFill(page, loc, SKU); break; }
  }
  await setTimeout(500);
  const full = page.getByRole('radio', { name: /full access|full/i }).first();
  if (await full.count() > 0) { try { await humanClickLocator(page, full); } catch (e) { console.log('[asc-app] full-access skip:', e.message?.slice(0, 50)); } }
  await setTimeout(500);
  const created = await clickByText(page, /^\s*create\s*$/i);
  console.log('[asc-app] create-clicked=' + created);
  await setTimeout(4000);
}

async function appExists() {
  const KEY_ID = 'ZA9F7Q6KQZ', ISSUER = '13148f85-32b2-485c-a7ed-3e1805314299';
  const PEM = process.env.ASC_P8;
  if (!PEM) { console.log('[asc-app] brak ASC_P8 — pomijam weryfikację API'); return null; }
  const b = (x) => Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const n = Math.floor(Date.now() / 1000);
  const h = b(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  const p = b(JSON.stringify({ iss: ISSUER, iat: n, exp: n + 600, aud: 'appstoreconnect-v1' }));
  const sig = crypto.createSign('SHA256').update(`${h}.${p}`).sign({ key: PEM, dsaEncoding: 'ieee-p1363' });
  const jwt = `${h}.${p}.${b(sig)}`;
  const r = await fetch(`https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE)}&limit=5`, { headers: { Authorization: `Bearer ${jwt}` } });
  const j = await r.json();
  return (j.data || [])[0] || null;
}

// Register the App ID (bundle id) via the Developer API first — this IS allowed
// (only POST /v1/apps is forbidden), and the ASC New App dialog only lists
// bundle ids already registered in the portal.
async function registerBundle() {
  const KEY_ID = process.env.ASC_KEY_ID || 'ZA9F7Q6KQZ';
  const ISSUER = process.env.ASC_ISSUER || '13148f85-32b2-485c-a7ed-3e1805314299';
  const PEM = process.env.ASC_P8;
  if (!PEM) { console.log('[asc-app] brak ASC_P8 — pomijam rejestrację App ID'); return; }
  const b = (x) => Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const n = Math.floor(Date.now() / 1000);
  const h = b(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  const p = b(JSON.stringify({ iss: ISSUER, iat: n, exp: n + 600, aud: 'appstoreconnect-v1' }));
  const sig = crypto.createSign('SHA256').update(`${h}.${p}`).sign({ key: PEM, dsaEncoding: 'ieee-p1363' });
  const jwt = `${h}.${p}.${b(sig)}`;
  const r = await fetch('https://api.appstoreconnect.apple.com/v1/bundleIds', {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { type: 'bundleIds', attributes: { identifier: BUNDLE, name: APP_NAME.replace(/[^A-Za-z0-9 ]/g, ''), platform: 'IOS' } } }),
  });
  const t = await r.text();
  console.log(`[asc-app] register App ID ${BUNDLE}: HTTP ${r.status} ${t.slice(0, 200)}`);
}

const existing = await appExists();
if (existing) { console.log('APP_ALREADY_EXISTS', existing.id, '|', existing.attributes?.name, '|', existing.attributes?.bundleId); process.exit(0); }
await registerBundle();

const s = await WSession.start({ label: 'asc_create_app', userDataDir: `${OUT_DIR}/${process.env.ASC_PROFILE || 'asc-profile-app'}`, headless: false });
await s.goto(APPS_URL);
await fillLogin(s);
await waitForAppsPage(s);
await setTimeout(2500);
await openNewAppDialog(s.page);
await fillDialog(s.page);

const app = await appExists();
if (app) console.log('APP_OK', app.id, '|', app.attributes?.name, '|', app.attributes?.bundleId);
else console.log('APP_NOT_FOUND_YET — sprawdź okno; rekord mógł nie zostać utworzony.');
console.log('[asc-app] zostawiam sesję otwartą.');
