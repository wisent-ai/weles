// Share an existing Google Doc.
//
// Run:
//   node weles/scripts/trajectories/google/drive/share_doc.mjs \
//     --doc https://docs.google.com/document/d/<id>/edit \
//     [--emails "a@x.com,b@y.com"] \
//     [--role viewer|commenter|editor] \
//     [--anyone]
//
// Env mirror of the flags: DOC_URL, DOC_EMAILS, DOC_ROLE, DOC_ANYONE=1.
// Other env: GM_EMAIL, GM_PASSWORD, BROWSER.
//
// Output:
//   SHARE_LINK: https://docs.google.com/document/d/<id>/edit?usp=sharing

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../../dist/human/keyboard.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DOC_URL = arg('--doc') || process.env.DOC_URL;
const EMAILS_RAW = arg('--emails') || process.env.DOC_EMAILS || '';
const EMAILS = EMAILS_RAW.split(',').map((e) => e.trim()).filter(Boolean);
const ROLE = (arg('--role') || process.env.DOC_ROLE || 'viewer').toLowerCase();
const ANYONE = process.argv.includes('--anyone') || process.env.DOC_ANYONE === '1';
const LABEL = 'drive_share_doc';

if (!DOC_URL) { console.log('FAIL: --doc (or DOC_URL) required'); process.exit(2); }
if (!/^viewer|commenter|editor$/.test(ROLE)) { console.log('FAIL: --role must be viewer|commenter|editor'); process.exit(2); }

function log(...a) { console.log('[drive_share_doc]', ...a); }

async function resolveCreds() {
  const email = process.env.GM_EMAIL || 'lukasz.bartoszcze@gmail.com';
  if (process.env.GM_PASSWORD) return { email, password: process.env.GM_PASSWORD };
  const fromDb = await getGoogleSsoCreds(email);
  if (fromDb?.password) return fromDb;
  throw new Error('No password: set GM_PASSWORD or add a service_credentials row for ' + email);
}

const ROLE_LABEL = { viewer: 'Viewer', commenter: 'Commenter', editor: 'Editor' }[ROLE];

const creds = await resolveCreds();
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || undefined });

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| doc:', DOC_URL, '| emails:', EMAILS.length, '| role:', ROLE, '| anyone:', ANYONE);
  await s.page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) { log('FAIL: googleSso did not complete (url=' + s.page.url() + ')'); process.exit(2); }
    await humanIdlePause('long');
    await s.page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
  }

  // Click Share (top-right). Multiple matchers because Docs A/Bs the
  // exact label and class. Wait for the share dialog title to appear.
  const shareBtn = s.page.locator('[aria-label*="Share" i]:not([role="menu"]), button:has-text("Share"), div[role="button"]:has-text("Share")').filter({ visible: true }).first();
  await shareBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, shareBtn);
  await humanIdlePause('deliberate');

  // Add each collaborator email.
  for (const email of EMAILS) {
    const peopleInput = s.page.locator('input[aria-label*="Add people" i], input[aria-label*="email" i], input[type="text"][placeholder*="email" i]').filter({ visible: true }).first();
    await peopleInput.waitFor({ state: 'visible' });
    await humanFill(s.page, peopleInput, email);
    await humanIdlePause('short');
    // Press Enter to commit the chip.
    await s.page.keyboard.press('Enter'); // allow-raw-playwright: commit-chip Enter press in people-picker
    await humanIdlePause('short');
    log('added: ' + email);
  }

  // Set the role dropdown to ROLE_LABEL if it isn't already.
  if (EMAILS.length > 0) {
    const roleDd = s.page.locator('button[aria-haspopup="listbox"]:has-text("Editor"), button[aria-haspopup="listbox"]:has-text("Viewer"), button[aria-haspopup="listbox"]:has-text("Commenter")').filter({ visible: true }).first();
    if (await roleDd.isVisible().catch(() => false)) {
      await humanClickLocator(s.page, roleDd);
      await humanIdlePause('short');
      const roleOption = s.page.getByRole('option', { name: new RegExp('^' + ROLE_LABEL + '$', 'i') }).first();
      await humanClickLocator(s.page, roleOption);
      await humanIdlePause('short');
    }
    // Submit invites
    const sendBtn = s.page.locator('button:has-text("Send"), button:has-text("Share"), button:has-text("Notify and share")').filter({ visible: true }).first();
    await humanClickLocator(s.page, sendBtn);
    await humanIdlePause('long');
  }

  // Anyone-with-link block.
  if (ANYONE) {
    // The "General access" row toggles a popover. Click "Restricted" /
    // "Anyone with the link" chip.
    const generalAccessRow = s.page.locator('div:has-text("Restricted"), div:has-text("General access")').filter({ visible: true }).first();
    await humanClickLocator(s.page, generalAccessRow);
    await humanIdlePause('short');
    const anyoneOption = s.page.getByRole('menuitem', { name: /Anyone with the link/i }).first();
    if (await anyoneOption.isVisible().catch(() => false)) {
      await humanClickLocator(s.page, anyoneOption);
      await humanIdlePause('short');
    }
    // Switch the anyone-role too.
    const anyoneRoleDd = s.page.locator('button[aria-haspopup="listbox"]:has-text("Viewer"), button[aria-haspopup="listbox"]:has-text("Commenter"), button[aria-haspopup="listbox"]:has-text("Editor")').filter({ visible: true }).first();
    if (await anyoneRoleDd.isVisible().catch(() => false)) {
      await humanClickLocator(s.page, anyoneRoleDd);
      await humanIdlePause('short');
      const anyoneRoleOption = s.page.getByRole('option', { name: new RegExp('^' + ROLE_LABEL + '$', 'i') }).first();
      await humanClickLocator(s.page, anyoneRoleOption);
      await humanIdlePause('short');
    }
  }

  // Read the copy-link URL. Docs renders it inside an <input readonly> in
  // the share dialog. Falls back to the canonical doc URL with ?usp=sharing.
  let shareLink = '';
  const linkInput = s.page.locator('input[readonly][value*="docs.google.com"], input[readonly][value*="document/d/"]').filter({ visible: true }).first();
  if (await linkInput.isVisible().catch(() => false)) {
    shareLink = await linkInput.inputValue();
  }
  if (!shareLink) {
    const idMatch = DOC_URL.match(/\/document\/d\/([A-Za-z0-9_-]+)/);
    if (idMatch) shareLink = `https://docs.google.com/document/d/${idMatch[1]}/edit?usp=sharing`;
  }

  // Close dialog
  const doneBtn = s.page.locator('button:has-text("Done"), button[aria-label="Close" i]').filter({ visible: true }).first();
  if (await doneBtn.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, doneBtn);
  }

  log('PASS: share complete');
  console.log('SHARE_LINK: ' + shareLink);
} finally {
  await s.close();
}
