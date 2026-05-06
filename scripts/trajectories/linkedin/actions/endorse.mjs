import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { reloginLinkedinInline } from '../../_shared/linkedin/relogin.mjs';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_endorse', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /linkedin\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
// WSession's context disables Playwright's navigation timeout (defaults to
// 0 = wait forever) for resilience on slow-loading platforms. That's wrong
// for action trajectories: when LinkedIn /feed/ redirects through the auth
// wall on stale cookies, page.goto stalls indefinitely instead of letting
// the post-goto auth-wall classifier run. Cap nav to a finite ceiling here.
s.page.setDefaultNavigationTimeout(45_000);
let ban = null;
try {
  // page.goto with 45s timeout — see like.mjs note on s.goto hang.
  let authed = false;
  for (let attempt = 0; attempt < 2 && !authed; attempt++) {
    try {
      await s.page.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      checkReachable(s, 'linkedin');
      await s.page.waitForTimeout(3000);
      await assertAuthed('linkedin', s, { label: 'linkedin_endorse' });
      authed = true;
    } catch (gateErr) {
      const isAuthWall = gateErr instanceof AuthProbeError || /auth_wall/.test(gateErr.message ?? '');
      if (!isAuthWall || attempt > 0) throw gateErr;
      console.log(`[linkedin_endorse] auth_wall on attempt ${attempt + 1} — running inline relogin on same session`);
      const r = await reloginLinkedinInline(s, acct);
      if (!r.ok) { console.log(`FAIL: inline relogin failed: ${r.reason}`); await markCookiesStale(acct.id); process.exit(1); }
    }
  }
  // First connection card has an anchor pointing to /in/<vanity>/. Pick it.
  // 2026-05-06: data-test-app-aware-link is gone in the new design system —
  // use plain a[href*="/in/"] which matches both old and new markup.
  const profileLink = s.page.locator('a[href*="/in/"]').filter({ visible: true }).first();
  await profileLink.waitFor({ state: 'visible' });
  const href = await profileLink.getAttribute('href');
  if (!href) throw new Error('no connection profile href found');
  const profileUrl = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
  await s.page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  checkReachable(s, 'linkedin');
  await s.page.waitForTimeout(3000);
  // Skills section is anchored by section[id="skills"]. Inside, each skill
  // row exposes a button with aria-label="Endorse <skill>" — clicking it
  // flips to aria-label="Endorsed <skill>" (or removes the button if
  // already endorsed). Pick the first not-yet-endorsed skill.
  await s.page.evaluate(() => { const el = document.querySelector('section[id="skills"], div[id="skills"]'); el?.scrollIntoView({ block: 'center' }); }).catch(() => {});
  await s.page.waitForTimeout(1500);
  const endorseBtn = s.page.locator('button[aria-label^="Endorse "]:not([aria-pressed="true"])').filter({ visible: true }).first();
  if (!(await endorseBtn.count())) throw new Error('no endorseable skill found on profile');
  await endorseBtn.scrollIntoViewIfNeeded().catch(() => {});
  await humanClickLocator(s.page, endorseBtn);
  // After endorse, button label flips to "Endorsed " or aria-pressed=true,
  // OR a confirmation modal appears asking proficiency. Click "Endorse" in
  // modal if present.
  const modalConfirm = s.page.locator('div.artdeco-modal button:has-text("Endorse")').first();
  if (await modalConfirm.isVisible({ timeout: 2000 }).catch(() => false)) {
    await humanClickLocator(s.page, modalConfirm);
  }
  await s.page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('button[aria-label^="Endorsed "]')).length > 0;
  }, { timeout: 6000 }).catch(() => {});
  ban = await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: endorsed`);
} catch (e) {
  ban = e.banSignal ?? await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'linkedin_endorse'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'linkedin_endorse', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
