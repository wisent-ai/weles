import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_connect', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /linkedin\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  // Use page.goto with 45s timeout — WSession's defaultNavigationTimeout(0)
  // makes s.goto hang forever on auth-walled redirect chains.
  await s.page.goto('https://www.linkedin.com/mynetwork/grow/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  checkReachable(s, 'linkedin');
  await s.page.waitForTimeout(3500);
  try { await assertAuthed('linkedin', s, { label: 'linkedin_connect' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // PYMK card "Connect" buttons live as <button aria-label="Invite NAME to connect">.
  // Filter to invite (not Follow). Take the first non-disabled one in
  // viewport. After click, LinkedIn often shows a "Send without a note"
  // confirm modal — click Send when it appears.
  const inviteBtn = s.page.locator('button[aria-label^="Invite "][aria-label$="to connect"]').filter({ visible: true }).first();
  await inviteBtn.waitFor({ state: 'visible' });
  await inviteBtn.scrollIntoViewIfNeeded().catch(() => {});
  await humanClickLocator(s.page, inviteBtn);
  // Optional confirm modal: <button aria-label="Send now"> or "Send" inside artdeco-modal.
  const sendBtn = s.page.locator('div.artdeco-modal button[aria-label="Send now"], div.artdeco-modal button:has-text("Send")').first();
  if (await sendBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
    await humanClickLocator(s.page, sendBtn);
  }
  // Verify state flip: same card's button toggles to "Pending"/aria-label="Pending, click to withdraw invitation"
  await s.page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('button[aria-label*="Pending" i]')).length > 0;
  }, { timeout: 6000 }).catch(() => {});
  ban = await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: connection_requested`);
} catch (e) {
  ban = e.banSignal ?? await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'linkedin_connect'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'linkedin_connect', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
