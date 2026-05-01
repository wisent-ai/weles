import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectInstagramBanSignals } from '../../../../dist/platforms/instagram/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { markCookiesStale } from '../../../../dist/utils/credentials.js';

const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_follow', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /instagram\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  const url = TARGET_USER ? `https://www.instagram.com/${encodeURIComponent(TARGET_USER)}/` : 'https://www.instagram.com/explore/people/';
  await s.goto(url);
  checkReachable(s, 'instagram');
  await s.page.waitForTimeout(3500);
  try { await assertAuthed('instagram', s, { label: 'instagram_follow' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // The follow CTA is a <button> with text "Follow" or "Follow back" in the
  // profile header. Once clicked, its text flips to "Following" (verifies
  // success). Filter to button-shaped follow exactly to avoid hitting
  // "Follow this hashtag" / "Follow suggestions" links.
  const followBtn = s.page.locator('button').filter({ hasText: /^\s*(Follow|Follow back)\s*$/ }).filter({ visible: true }).first();
  // Already following? "Following" button visible means PASS idempotent.
  const followingBtn = s.page.locator('button').filter({ hasText: /^\s*(Following|Requested)\s*$/ }).filter({ visible: true }).first();
  if (await followingBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already following`);
  } else {
    await followBtn.waitFor({ state: 'visible' });
    await followBtn.scrollIntoViewIfNeeded().catch(() => {});
    await humanClickLocator(s.page, followBtn);
    await s.page.locator('button').filter({ hasText: /^\s*(Following|Requested)\s*$/ }).first().waitFor({ state: 'visible' });
    ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: followed`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'instagram_follow'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'instagram_follow', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
