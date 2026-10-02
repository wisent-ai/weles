import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/auth/cookie-freshness.mjs';

const HOME_URL = 'https://x.com/home';

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account in DB'); process.exitCode = 1; }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_like', proxy: proxyUrl, persona });

try {
  // Cookie freshness gate — see _shared/auth/cookie-freshness.mjs.
  let prepared;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'twitter', label: 'twitter_like', currentProxyUrl: proxyUrl, currentPersona: persona });
    const hasAuthToken = all.some(c => c?.name === 'auth_token' && c?.value);
    if (!hasAuthToken) throw new CookieJarStaleError('cookie_jar_missing_auth_token: jar fresh but no auth_token', { platform: 'twitter' });
    prepared = all.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }));
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exitCode = 1; }
    throw jarErr;
  }
  await s.ctx.addCookies(prepared);

  await s.page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const url = s.page.url();
  if (/\/i\/flow\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); await markCookiesStale(acct.id); process.exitCode = 1; }

  // Positive auth probe — auth_token in jar ≠ session is real. Twitter
  // serves a logged-out shell on x.com/home for cookie-injected sessions
  // it doesn't trust. URL doesn't bounce, but compose / DM / profile
  // links are absent. See _shared/auth/auth-probe.mjs.
  try {
    await assertAuthed('twitter', s, { label: 'twitter_like' });
  } catch (probeErr) {
    if (probeErr instanceof AuthProbeError) {
      console.log(`FAIL: ${probeErr.message}`);
      await markCookiesStale(acct.id);
      process.exitCode = 1;
    }
    throw probeErr;
  }

  // The /home timeline can be empty for very-new accounts whose For-You
  // algorithm hasn't been built yet — Twitter shows the compose box and
  // sidebar but no cellInnerDiv tweets. Detect this and fall through to
  // a populated profile timeline (elonmusk's). Verified 2026-04-29 with
  // eddiekeeling2594: /home cellInnerDiv count=0, /elonmusk has 20+
  // visible tweets within 5s.
  await pageSettled(s.page);
  let likeBtn = s.page.locator('[data-testid="like"]').filter({ visible: true }).first();
  if (!await likeBtn.isVisible()) {
    console.log('[trajectory] /home empty — falling to /elonmusk timeline');
    await s.page.goto('https://x.com/elonmusk', { waitUntil: 'domcontentloaded' });
    likeBtn = s.page.locator('[data-testid="like"]').filter({ visible: true }).first();
    await likeBtn.waitFor({ state: 'visible' });
  }
  await likeBtn.scrollIntoViewIfNeeded();
  await humanClickLocator(s.page, likeBtn);
  await humanIdlePause('deliberate');
  // Verify like → unlike transition (the same button now exposes data-testid="unlike")
  const unlikeBtn = s.page.locator('[data-testid="unlike"]').first();
  const ok = await unlikeBtn.isVisible().catch(() => false);
  if (!ok) { console.log('FAIL: clicked like but no unlike state — likely shadowbanned or rate-limited'); process.exitCode = 1; }
  console.log('PASS: liked tweet');
} catch (e) {
  console.log('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await s.close();
}
