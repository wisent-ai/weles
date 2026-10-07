import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { openLinkedinAuthed } from '../../_shared/linkedin/authed_open.mjs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_endorse', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /linkedin\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  const opened = await openLinkedinAuthed(s, acct, 'linkedin_endorse', async () => {
    await s.page.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/', { waitUntil: 'domcontentloaded' });
    checkReachable(s, 'linkedin');
    await humanIdlePause('deliberate');
  });
  if (!opened.ok) { console.log(`FAIL: inline relogin failed: ${opened.reason}`); await markCookiesStale(acct.id); process.exit(1); }
  // First connection card has an anchor pointing to /in/<vanity>/. Pick it.
  // data-test-app-aware-link is gone in the new design system —
  // use plain a[href*="/in/"] which matches both old and new markup. Detect
  // empty-connections state explicitly and exit with a clear precondition
  // message instead of a 30s locator timeout (fresh accounts have 0
  // connections, so endorse is a no-op for them — caller must wait for
  // accepted invitations first).
  const profileLink = s.page.locator('a[href*="/in/"]').filter({ visible: true }).first();
  const visibleCount = await s.page.locator('a[href*="/in/"]').count().catch(() => 0);
  if (visibleCount === 0) {
    console.log('FAIL: no_connections_to_endorse — account has 0 accepted connections');
    await s.close().catch(() => {});
    process.exit(0); // benign exit, not a code error
  }
  await profileLink.waitFor({ state: 'visible' });
  const href = await profileLink.getAttribute('href');
  if (!href) throw new Error('no connection profile href found');
  const profileUrl = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
  await s.page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  checkReachable(s, 'linkedin');
  await humanIdlePause('deliberate');
  // Skills section is anchored by section[id="skills"]. Inside, each skill
  // row exposes a button with aria-label="Endorse <skill>" — clicking it
  // flips to aria-label="Endorsed <skill>" (or removes the button if
  // already endorsed). Pick the first not-yet-endorsed skill.
  await s.page.evaluate(() => { const el = document.querySelector('section[id="skills"], div[id="skills"]'); el?.scrollIntoView({ block: 'center' }); }).catch(() => {});
  await humanIdlePause('short');
  const endorseBtn = s.page.locator('button[aria-label^="Endorse "]:not([aria-pressed="true"])').filter({ visible: true }).first();
  if (!(await endorseBtn.count())) throw new Error('no endorseable skill found on profile');
  await endorseBtn.scrollIntoViewIfNeeded().catch(() => {});
  await humanClickLocator(s.page, endorseBtn);
  // After endorse, button label flips to "Endorsed " or aria-pressed=true,
  // OR a confirmation modal appears asking proficiency. Click "Endorse" in
  // modal if present.
  const modalConfirm = s.page.locator('div.artdeco-modal button:has-text("Endorse")').first();
  await pageSettled(s.page);
  if (await modalConfirm.isVisible()) {
    await humanClickLocator(s.page, modalConfirm);
    await pageSettled(s.page);
  }
  const endorsed = await s.page.locator('button[aria-label^="Endorsed "]').count();
  if (endorsed === 0) throw new Error('linkedin_endorse: no Endorsed button after the endorse click');
  ban = await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: endorsed`);
} catch (e) {
  ban = e.banSignal ?? await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('linkedin_endorse'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'linkedin_endorse', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
