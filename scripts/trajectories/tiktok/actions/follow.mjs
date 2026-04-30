import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectTikTokBanSignals } from '../../../../dist/platforms/tiktok/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

// When TARGET_USER is unset, default to TikTok's official account — gives a
// deterministic, always-populated profile page rather than relying on the
// /foryou feed's per-session creator selection.
const TARGET_USER = (process.env.TARGET_USER || 'tiktok').replace(/^@/, '');

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_follow', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /tiktok\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto(`https://www.tiktok.com/@${encodeURIComponent(TARGET_USER)}`);
  checkReachable(s, 'tiktok');
  await s.page.waitForTimeout(3500);
  // Idempotent: if already following, exit clean.
  const followingBtn = s.page.locator('button[data-e2e="follow-icon"], button:has-text("Following")').filter({ visible: true }).first();
  if (await followingBtn.count().catch(() => 0) > 0) {
    ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already following @${TARGET_USER}`);
  } else {
    // Profile page Follow button: data-e2e="follow-button" on web; after
    // a successful follow it switches to data-e2e="follow-icon" (Following).
    const followBtn = s.page.locator('button[data-e2e="follow-button"]').filter({ visible: true }).first();
    await followBtn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, followBtn);
    await humanIdlePause('deliberate');
    await followingBtn.waitFor({ state: 'visible' });
    ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: followed @${TARGET_USER}`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'tiktok_follow'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_follow', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
