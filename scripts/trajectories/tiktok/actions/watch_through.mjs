import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectTikTokBanSignals } from '../../../../dist/platforms/tiktok/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';
import { markCookiesStale } from '../../../../dist/utils/credentials.js';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

// Watch-through = sit on a single FYP video for its full duration plus one
// replay, then advance. TikTok's recommender uses watch-through ratio as a
// major signal; the ratio must look human.

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_watch_through', proxy: proxyUrl, persona });
// Cookie freshness gate — see _shared/cookie-freshness.mjs.
let _stored;
try {
  const _all = loadFreshCookieJarOrFail(acct, { platform: 'tiktok', label: 'tiktok_watch_through', currentProxyUrl: proxyUrl, currentPersona: persona });
  _stored = _all.filter(c => /tiktok\.com/.test(c.domain ?? ''));
  if (!_stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no tiktok.com cookies', { platform: 'tiktok' });
} catch (jarErr) {
  if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); await s.close().catch(() => {}); process.exit(1); }
  throw jarErr;
}
await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto('https://www.tiktok.com/foryou');
  checkReachable(s, 'tiktok');
  await humanIdlePause('deliberate');
  try { await assertAuthed('tiktok', s, { label: 'tiktok_watch_through' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // Sit on the first video for ~30s (avg TikTok length ~15s, so this is a
  // full watch + about one replay loop). Then advance twice with short dwell.
  await humanIdlePause();
  await s.page.keyboard.press('ArrowDown');
  await humanIdlePause();
  await s.page.keyboard.press('ArrowDown');
  await humanIdlePause();
  ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: watched_through_3`);
} catch (e) {
  ban = e.banSignal ?? await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'tiktok_watch_through'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_watch_through', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
