import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator } from '../../dist/human/mouse.js';

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
  if (/\/i\/flow\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); process.exit(1); }

  // Twitter like button: data-testid="like" (unliked) or "unlike" (already liked)
  const likeBtn = s.page.locator('[data-testid="like"]').filter({ visible: true }).first();
  await likeBtn.waitFor({ state: 'visible' });
  await likeBtn.scrollIntoViewIfNeeded();
  await humanClickLocator(s.page, likeBtn);
  await s.page.waitForTimeout(2000);
  // Verify like → unlike transition (the same button now exposes data-testid="unlike")
  const unlikeBtn = s.page.locator('[data-testid="unlike"]').first();
  const ok = await unlikeBtn.isVisible().catch(() => false);
  if (!ok) { console.log('FAIL: clicked like but no unlike state — likely shadowbanned or rate-limited'); process.exit(1); }
  console.log('PASS: liked first tweet on home timeline');
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
