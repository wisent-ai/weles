import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator } from '../../dist/human/mouse.js';

// TikTok's /foryou page renders an empty body for sessions flagged by the
// fingerprint/proxy heuristics — videoCount=1 (the auto-play element) but
// btnCount=0, no like buttons in DOM. The right-rail action toolbar is
// SPA-hydrated only when TikTok trusts the session.
//
// Verified on 2026-04-29 with a known-good cookie-first session
// (sessionid present, tiktok_login PASS): /foryou bodyLen=0, /@tiktok
// profile bodyLen=311 + working follow button, and clicking through to
// /@tiktok/video/{id} reveals a like button with data-e2e="browse-like-icon"
// (aria-label="<N> Likes", aria-pressed="false"). Use that flow.
const TARGET_USER = (process.env.TARGET_USER || 'tiktok').replace(/^@/, '');
const PROFILE_URL = `https://www.tiktok.com/@${encodeURIComponent(TARGET_USER)}`;

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_like', proxy: proxyUrl, persona });

try {
  // Cookie-first auth.
  const stored = (acct.metadata?.cookies ?? []).filter(c => /tiktok\.com/.test(c.domain ?? ''));
  if (!stored.length) { console.log('FAIL: no tiktok cookies — login first'); process.exit(1); }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  // 1. Navigate to a profile that always has the action bar working
  //    (TikTok official @tiktok = inelastic, never empties feed).
  await s.page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded' });
  // TikTok's profile-grid render is fingerprint-gated: some sessions get
  // bodyLen=0 with no anchor links, others get a full grid in 6s. Poll
  // up to 30s for the first /video/ anchor to appear; if it never does the
  // session has been render-shadowed and we have to mark cookies for
  // refresh (the same pattern as a logged-out redirect).
  const firstVideo = s.page.locator('a[href*="/video/"]').first();
  const profileLoaded = await firstVideo.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
  if (!profileLoaded) {
    const bodyLen = await s.page.evaluate(() => document.body?.innerText?.length || 0);
    console.log(`FAIL: profile @${TARGET_USER} did not render video grid (bodyLen=${bodyLen}) — fingerprint-gated`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }

  // sessionid is httpOnly — document.cookie can't see it. Read cookies via
  // the browser context API, which returns httpOnly cookies too.
  const ctxCookies = await s.ctx.cookies();
  const hasSessionId = ctxCookies.some(c => c.name === 'sessionid' && (c.domain || '').includes('tiktok'));
  if (!hasSessionId) {
    console.log('FAIL: cookies stale (no sessionid) — login first');
    await markCookiesStale(acct.id);
    process.exit(1);
  }

  // 2. TikTok render-shadows ~50% of video-page hydrations: the URL navigates
  //    but the right rail never mounts (bodyLen=0, btnCount=0). The trust
  //    state appears to be rolled per-navigation, not per-session, so the
  //    same account on the same proxy will alternate between hydrated and
  //    blank loads. Retry up to 4 different videos, taking the first that
  //    hydrates a like button. Each click is a fresh attempt at hydration.
  const videoLinks = await s.page.locator('a[href*="/video/"]').all();
  const candidates = videoLinks.slice(0, Math.min(4, videoLinks.length));
  let likeBtn = null;
  let videoHref = null;
  for (let i = 0; i < candidates.length; i++) {
    const link = candidates[i];
    videoHref = await link.getAttribute('href').catch(() => null);
    if (i > 0) {
      // Navigate back to the profile so we can click a different video.
      await s.page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded' });
      await s.page.locator('a[href*="/video/"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    }
    try { await humanClickLocator(s.page, candidates[i]); } catch { continue; }
    await s.page.waitForURL(/\/video\/\d+/, { timeout: 15000 }).catch(() => {});
    // Hydrate-or-bust: 25s window per video. The right-rail mounts at ~9s
    // on a happy session.
    const candidate = s.page.locator('button[data-e2e="like-icon"], button[data-e2e="browse-like-icon"], button:has([data-e2e="like-icon"]), button:has([data-e2e="browse-like-icon"])').filter({ visible: true }).first();
    const hit = await candidate.waitFor({ state: 'visible', timeout: 25000 }).then(() => true).catch(() => false);
    if (hit) {
      likeBtn = candidate;
      console.log(`[trajectory] like button hydrated on video ${i + 1}/${candidates.length} (${videoHref})`);
      break;
    }
    console.log(`[trajectory] video ${i + 1}/${candidates.length} did not hydrate like button — retrying`);
  }
  if (!likeBtn) {
    const tids = await s.page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('[data-e2e]')).map(e => e.getAttribute('data-e2e')))].filter(t => /like|action|browse|video/i.test(t)).slice(0, 15));
    console.log(`FAIL: no like button found after ${candidates.length} video attempts. last data-e2e: ${JSON.stringify(tids)}`);
    process.exit(1);
  }
  await likeBtn.scrollIntoViewIfNeeded();

  // Capture the digg XHR for diagnostics on failure.
  let diggResp = null;
  s.page.on('response', async (resp) => {
    if (!/digg/.test(resp.url())) return;
    try { diggResp = { status: resp.status(), url: resp.url(), body: (await resp.text()).slice(0, 400) }; } catch {}
  });

  const before = await likeBtn.getAttribute('aria-pressed');
  await humanClickLocator(s.page, likeBtn);

  // Poll: the like XHR can take 3-8s. aria-pressed flips after API confirms.
  let after = before;
  for (let i = 0; i < 12; i++) {
    await s.page.waitForTimeout(1000);
    after = await likeBtn.getAttribute('aria-pressed').catch(() => null);
    if (after === 'true' && before !== 'true') break;
  }
  if (before === 'true') { console.log('PASS: already liked (aria-pressed was already true)'); }
  else if (after === 'true') { console.log(`PASS: liked video ${videoHref}`); }
  else {
    const diggInfo = diggResp ? ` digg=${diggResp.status} body=${diggResp.body.replace(/\s+/g, ' ').slice(0, 200)}` : ' digg=no_xhr_observed';
    console.log(`FAIL: aria-pressed did not flip (before=${before} after=${after})${diggInfo}`);
    process.exit(1);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
