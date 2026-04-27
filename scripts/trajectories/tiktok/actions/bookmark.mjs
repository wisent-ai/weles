import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { execute } from '../../../../dist/agent/loop.js';
import { detectTikTokBanSignals } from '../../../../dist/platforms/tiktok/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_bookmark', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /tiktok\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto(TARGET_URL || 'https://www.tiktok.com/foryou');
  checkReachable(s, 'tiktok');
  await s.page.waitForTimeout(4000);
  const goal = `You are on a TikTok video page (FYP or specific video). Find the bookmark icon on the right-hand action rail (data-e2e="video-save" or labelled "Add to Favorites"). Click it. done(value="bookmarked"). Do NOT navigate(). Do NOT give_up.`;
  const result = await execute(s, goal, { flowName: 'tiktok_bookmark' });
  ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: ${result.value}`);
} catch (e) {
  ban = e.banSignal ?? await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'tiktok_bookmark'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_bookmark', target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
