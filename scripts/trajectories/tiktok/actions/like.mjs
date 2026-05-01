import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectTikTokBanSignals } from '../../../../dist/platforms/tiktok/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';
import { markCookiesStale } from '../../../../dist/utils/credentials.js';

const TARGET_URL  = process.env.TARGET_URL || '';
const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');
const SEARCH_QUERY = (process.env.SEARCH_QUERY || '').replace(/^#/, '');

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_like', proxy: proxyUrl, persona });
// Cookie freshness gate — see _shared/cookie-freshness.mjs.
let _stored;
try {
  const _all = loadFreshCookieJarOrFail(acct, { platform: 'tiktok', label: 'tiktok_like', currentProxyUrl: proxyUrl, currentPersona: persona });
  _stored = _all.filter(c => /tiktok\.com/.test(c.domain ?? ''));
  if (!_stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no tiktok.com cookies', { platform: 'tiktok' });
} catch (jarErr) {
  if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); await s.close().catch(() => {}); process.exit(1); }
  throw jarErr;
}
await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  let url;
  if (TARGET_URL) url = TARGET_URL;
  else if (TARGET_USER) url = `https://www.tiktok.com/@${encodeURIComponent(TARGET_USER)}`;
  else if (SEARCH_QUERY) url = `https://www.tiktok.com/tag/${encodeURIComponent(SEARCH_QUERY)}`;
  else url = 'https://www.tiktok.com/foryou';
  await s.goto(url);
  checkReachable(s, 'tiktok');
  await s.page.waitForTimeout(4000);
  try { await assertAuthed('tiktok', s, { label: 'tiktok_like' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // If we landed on a profile / hashtag grid, navigate into the first video.
  // Specific-video URLs and /foryou already have the right-rail action panel
  // hydrated in place.
  if (!/\/video\//.test(s.page.url()) && !/\/foryou/.test(s.page.url())) {
    const firstVideo = s.page.locator('a[href*="/video/"]').first();
    await firstVideo.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, firstVideo);
    await s.page.waitForURL(/\/video\/\d+/);
  }
  // Like button on TikTok video pages: data-e2e="like-icon" (foryou rail) or
  // "browse-like-icon" (profile-derived video page). Either match works.
  const likeBtn = s.page.locator('button[data-e2e="like-icon"], button[data-e2e="browse-like-icon"], button:has([data-e2e="like-icon"]), button:has([data-e2e="browse-like-icon"])').filter({ visible: true }).first();
  await likeBtn.waitFor({ state: 'visible' });
  await likeBtn.scrollIntoViewIfNeeded();
  const before = await likeBtn.getAttribute('aria-pressed').catch(() => null);
  if (before === 'true') {
    ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already liked`);
  } else {
    await humanClickLocator(s.page, likeBtn);
    // Poll for aria-pressed to flip — TikTok's digg XHR can take 3-8s.
    await s.page.waitForFunction(
      (el) => el?.getAttribute('aria-pressed') === 'true',
      await likeBtn.elementHandle(),
    );
    ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: liked`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'tiktok_like'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_like', target_url: TARGET_URL, target_user: TARGET_USER, search_query: SEARCH_QUERY, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
