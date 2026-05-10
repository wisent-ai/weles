import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from './_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from './_shared/cookie-freshness.mjs';

const TARGET_URL = process.env.TARGET_URL || 'https://www.instagram.com/explore/';

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_like', proxy: proxyUrl, persona });

try {
  // Cookie freshness gate — see _shared/cookie-freshness.mjs.
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'instagram', label: 'instagram_like', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /instagram\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no instagram.com cookies', { platform: 'instagram' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const url = s.page.url();
  if (/\/accounts\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); await markCookiesStale(acct.id); process.exit(1); }
  // Positive auth probe — see _shared/auth-probe.mjs.
  try { await assertAuthed('instagram', s, { label: 'instagram_like' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // Open first post: clicking the first <a href*="/p/"> in the feed/explore.
  const firstPost = s.page.locator('a[href*="/p/"]').filter({ visible: true }).first();
  await firstPost.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, firstPost);
  await humanIdlePause('deliberate');

  // The like button on a post is <svg aria-label="Like"> wrapped in a clickable
  // div role=button. After click aria-label becomes "Unlike". Filter to the
  // primary like (post-level), not comment-level by picking the first visible.
  const likeBtn = s.page.locator('div[role="button"]:has(svg[aria-label="Like"]), svg[aria-label="Like"]').filter({ visible: true }).first();
  const unlikeBtn = s.page.locator('svg[aria-label="Unlike"]').filter({ visible: true }).first();
  const alreadyLiked = await unlikeBtn.count().catch(() => 0);
  if (alreadyLiked > 0) { console.log('PASS: already liked first post'); process.exit(0); }
  await likeBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, likeBtn);
  await humanIdlePause('deliberate');
  const after = await s.page.locator('svg[aria-label="Unlike"]').filter({ visible: true }).count().catch(() => 0);
  if (after === 0) { console.log('FAIL: clicked Like but no transition to Unlike state'); process.exit(1); }
  console.log('PASS: liked first post on explore');
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
