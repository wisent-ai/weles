import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectTwitterBanSignals } from '../../../../dist/platforms/twitter/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_follow', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /x\.com|twitter\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  const url = TARGET_USER ? `https://x.com/${encodeURIComponent(TARGET_USER)}` : 'https://x.com/home';
  await s.goto(url);
  checkReachable(s, 'twitter');
  await humanIdlePause('deliberate');
  // Deterministic: data-testid="<userId>-follow" is the unfollowed state;
  // after a successful follow the same testid switches to "<userId>-unfollow".
  // When TARGET_USER is set we scope by aria-label to the target's button
  // (avoids accidentally clicking a "Who to follow" sidebar suggestion).
  const followSel = TARGET_USER
    ? `[data-testid$="-follow"][aria-label*="${TARGET_USER}"]`
    : `[data-testid$="-follow"]`;
  const unfollowSel = TARGET_USER
    ? `[data-testid$="-unfollow"][aria-label*="${TARGET_USER}"]`
    : `[data-testid$="-unfollow"]`;
  // If already following the target, exit clean. (Idempotent action.)
  if (TARGET_USER && await s.page.locator(unfollowSel).first().isVisible().catch(() => false)) {
    ban = await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already following @${TARGET_USER}`);
  } else {
    const followBtn = s.page.locator(followSel).filter({ visible: true }).first();
    await followBtn.waitFor({ state: 'visible' });
    await followBtn.scrollIntoViewIfNeeded();
    await humanClickLocator(s.page, followBtn);
    await s.page.locator(unfollowSel).first().waitFor({ state: 'visible' });
    ban = await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: followed${TARGET_USER ? ` @${TARGET_USER}` : ''}`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'twitter_follow'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'twitter_follow', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
