import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator } from '../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from './_shared/auth-probe.mjs';

const HOME_URL = 'https://x.com/home';

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_like', proxy: proxyUrl, persona });

try {
  // Cookie-first: inject auth_token, navigate to /home, click first like button
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  const hasAuthToken = stored.some(c => c?.name === 'auth_token' && c?.value);
  if (!hasAuthToken) { console.log('FAIL: no auth_token in stored cookies — login first'); process.exit(1); }
  const prepared = stored.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }));
  await s.ctx.addCookies(prepared);

  await s.page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(4000);
  const url = s.page.url();
  if (/\/i\/flow\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); await markCookiesStale(acct.id); process.exit(1); }

  // Positive auth probe — auth_token in jar ≠ session is real. Twitter
  // serves a logged-out shell on x.com/home for cookie-injected sessions
  // it doesn't trust. URL doesn't bounce, but compose / DM / profile
  // links are absent. See _shared/auth-probe.mjs.
  try {
    await assertAuthed('twitter', s, { label: 'twitter_like' });
  } catch (probeErr) {
    if (probeErr instanceof AuthProbeError) {
      console.log(`FAIL: ${probeErr.message}`);
      await markCookiesStale(acct.id);
      process.exit(1);
    }
    throw probeErr;
  }

  // The /home timeline can be empty for very-new accounts whose For-You
  // algorithm hasn't been built yet — Twitter shows the compose box and
  // sidebar but no cellInnerDiv tweets. Detect this and fall through to
  // a populated profile timeline (elonmusk's). Verified 2026-04-29 with
  // eddiekeeling2594: /home cellInnerDiv count=0, /elonmusk has 20+
  // visible tweets within 5s.
  let likeBtn = s.page.locator('[data-testid="like"]').filter({ visible: true }).first();
  let hasLikeBtn = await likeBtn.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!hasLikeBtn) {
    console.log('[trajectory] /home empty — falling to /elonmusk timeline');
    await s.page.goto('https://x.com/elonmusk', { waitUntil: 'domcontentloaded' });
    await s.page.waitForTimeout(4000);
    likeBtn = s.page.locator('[data-testid="like"]').filter({ visible: true }).first();
    hasLikeBtn = await likeBtn.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    if (!hasLikeBtn) { console.log('FAIL: no like button visible on either /home or /elonmusk'); process.exit(1); }
  }
  await likeBtn.scrollIntoViewIfNeeded();
  await humanClickLocator(s.page, likeBtn);
  await s.page.waitForTimeout(2000);
  // Verify like → unlike transition (the same button now exposes data-testid="unlike")
  const unlikeBtn = s.page.locator('[data-testid="unlike"]').first();
  const ok = await unlikeBtn.isVisible().catch(() => false);
  if (!ok) { console.log('FAIL: clicked like but no unlike state — likely shadowbanned or rate-limited'); process.exit(1); }
  console.log('PASS: liked tweet');
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
