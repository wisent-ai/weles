// Capture screenshot + video evidence of a shared Drive folder and the
// version-history panels of its editor files, from a real signed-in session.
//
// Reads the file inventory from a drive_preserve.py archive directory and
// visits every file's webViewLink. For Docs/Sheets/Slides it opens the native
// Version history panel (Cmd+Alt+Shift+H) and scrolls it to the end. Every
// shot is logged in a manifest with URL, UTC timestamp and sha256. The .webm
// session recording lands in recordings/<label>/ as continuous evidence.
//
// Run:
//   GM_EMAIL=lukasz.bartoszcze@wisent.ai WELES_NO_INSTRUMENT=1 \
//   node weles/scripts/trajectories/google/drive/evidence/version_history.mjs \
//     --archive <drive_preserve output dir> --out <manifest.json path>

import { WSession } from '../../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../../_shared/services/google_sso.mjs';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ARCHIVE = arg('--archive');
const OUT_PATH = arg('--out');
const LABEL = 'drive_version_history';
const EDITOR_MIMES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

if (!ARCHIVE || !OUT_PATH) {
  console.log('FAIL: --archive <dir> and --out <manifest.json> required');
  process.exit(2);
}

class SignedOutMidRun extends Error {}

function log(...a) { console.error('[' + LABEL + ']', ...a); }
function nowIso() { return new Date().toISOString(); }
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

const rootMeta = JSON.parse(
  readFileSync(join(ARCHIVE, 'folder_metadata.json'), 'utf8')).root;
const metas = readdirSync(join(ARCHIVE, 'files'))
  .map((id) => JSON.parse(
    readFileSync(join(ARCHIVE, 'files', id, 'metadata.json'), 'utf8')))
  .sort((a, b) => a.name.localeCompare(b.name));

async function resolveCreds() {
  const email = process.env.GM_EMAIL;
  if (!email) throw new Error('GM_EMAIL required for this evidence capture');
  if (process.env.GM_PASSWORD) return { email, password: process.env.GM_PASSWORD };
  const fromDb = await getGoogleSsoCreds(email);
  if (fromDb?.password) return fromDb;
  throw new Error('No service_credentials row with password for ' + email);
}

const creds = await resolveCreds();
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || 'chromium' });
const shots = [];
const errors = [];

async function shot(tag) {
  const p = await s.screenshot(tag);
  const entry = { tag, path: p, url: s.page.url(), captured_at: nowIso(),
                  sha256: sha256File(p) };
  shots.push(entry);
  return entry;
}

// Capture, scroll at viewport point, recapture — until two identical frames.
async function scrollSeries(tag, xFrac, yFrac) {
  const vs = s.page.viewportSize();
  let prev = null;
  for (let i = 0; ; i++) {
    const e = await shot(tag + '_' + String(i).padStart(3, '0'));
    if (prev !== null && e.sha256 === prev) return i + 1;
    prev = e.sha256;
    await s.page.mouse.move(vs.width * xFrac, vs.height * yFrac);
    await s.page.mouse.wheel(0, Math.floor(vs.height / 2));
    await humanIdlePause('deliberate');
  }
}

// Anonymous Drive/Docs link-views render a top-bar "Sign in" link to the
// accounts.google.com ServiceLogin/signin endpoints instead of redirecting,
// so URL checks alone miss the signed-out state. The signed-in avatar is ALSO
// an accounts.google.com anchor (SignOutOptions) — match only sign-IN hrefs,
// or the avatar itself reads as signed-out (proven by frame d3f8d813_last:
// Share button + "Ł" avatar present, yet the broad selector threw).
async function isSignedOut() {
  return (await s.page.locator(
    'a[href*="ServiceLogin"], a[href*="accounts.google.com/signin"], ' +
    'a[href*="accounts.google.com/v3/signin"]')
    .filter({ visible: true }).count()) > 0;
}

async function ensureLoggedIn(url) {
  await s.page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const onLoginPage = /accounts\.google\.com|ServiceLogin|signin/.test(s.page.url());
  if (!onLoginPage && !(await isSignedOut())) return;
  if (!onLoginPage) {
    await s.page.goto('https://accounts.google.com/ServiceLogin?continue=' +
      encodeURIComponent(url), { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
  }
  log('signed out — running googleSso for', creds.email);
  const ok = await googleSso(s, creds);
  if (!ok) throw new Error('googleSso did not complete (url=' + s.page.url() + ')');
  await humanIdlePause('long');
  await s.page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  if (await isSignedOut()) {
    throw new Error('still signed out after googleSso (url=' + s.page.url() + ')');
  }
}

async function captureVersionPanel(meta) {
  // Open via the File menu, not the keyboard shortcut: Docs binds the chord
  // by the persona's UA OS (Meta+… on mac, Ctrl+… on windows) and requires
  // editor focus — the menu path depends on neither, and the click sequence
  // is itself visible in the evidence recording.
  const fileMenu = s.page.getByRole('menuitem', { name: 'File', exact: true }).first();
  await fileMenu.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, fileMenu);
  const vhItem = s.page.getByRole('menuitem', { name: /Version history/ }).first();
  await vhItem.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, vhItem);
  const seeItem = s.page.getByRole('menuitem', { name: /See version history/ }).first();
  await seeItem.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, seeItem);
  await s.page.getByText('Version history', { exact: false }).first()
    .waitFor({ state: 'visible' });
  await humanIdlePause('deliberate');
  const frames = await scrollSeries('versions_' + meta.id, 0.92, 0.5);
  log('  version panel frames:', frames);
}

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown',
      '| folder:', rootMeta.name, '| files:', metas.length);

  await ensureLoggedIn(rootMeta.webViewLink);
  const listingFrames = await scrollSeries('folder_listing', 0.5, 0.5);
  log('folder listing frames:', listingFrames);

  for (const [i, meta] of metas.entries()) {
    log('[' + (i + 1) + '/' + metas.length + ']', meta.name);
    try {
      await s.page.goto(meta.webViewLink, { waitUntil: 'domcontentloaded' });
      await humanIdlePause('long');
      if (await isSignedOut()) {
        // Anonymous shots are not evidence — abort the whole run, loudly.
        throw new SignedOutMidRun('signed out at ' + meta.webViewLink);
      }
      await shot('file_' + meta.id);
      if (EDITOR_MIMES.has(meta.mimeType)) {
        await captureVersionPanel(meta);
      }
    } catch (e) {
      if (e instanceof SignedOutMidRun) throw e;
      errors.push({ file: meta.id, name: meta.name, at: nowIso(),
                    step: 'capture', error: String(e) });
      log('  ERROR:', String(e));
    }
  }
} finally {
  const manifest = {
    folder_id: rootMeta.id, folder_name: rootMeta.name,
    account: creds.email, finished_at: nowIso(),
    shot_count: shots.length, error_count: errors.length,
    shots, errors,
  };
  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2));
  log('manifest written:', OUT_PATH, '| shots:', shots.length,
      '| errors:', errors.length);
  await s.close();
}

if (errors.length > 0) {
  console.log('PARTIAL: ' + shots.length + ' shots, ' + errors.length +
              ' errors (see manifest)');
  process.exit(2);
}
console.log('OK: ' + shots.length + ' shots captured, manifest at ' + OUT_PATH);
