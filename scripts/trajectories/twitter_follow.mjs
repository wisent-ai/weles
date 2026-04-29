import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator } from '../../dist/human/mouse.js';

const TARGET_HANDLE = 'elonmusk';
const TARGET_URL = `https://x.com/${TARGET_HANDLE}`;

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_follow', proxy: proxyUrl, persona });

try {
  // Cookie-first: inject stored auth_token, navigate to target user, click Follow
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  const hasAuthToken = stored.some(c => c?.name === 'auth_token' && c?.value);
  if (!hasAuthToken) { console.log('FAIL: no auth_token in stored cookies — login first'); process.exit(1); }
  const prepared = stored.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }));
  await s.ctx.addCookies(prepared);
  console.log(`[trajectory] injected ${prepared.length} stored cookies`);

  await s.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  // x.com SPA needs ~6-8s to hydrate the profile page after domcontentloaded;
  // a hard 4s sleep was racing the React mount and producing "no Follow
  // button visible" with empty testid list. Use locator.waitFor on the
  // canonical Follow / Following button selector instead — it polls until
  // either appears or 30s expires. The selector intentionally allows BOTH
  // states (-follow and -unfollow) so the wait succeeds even if the account
  // already follows the target (we then branch on which one matched).
  await s.page.locator(`[data-testid$="-follow"][aria-label*="${TARGET_HANDLE}"], [data-testid$="-unfollow"][aria-label*="${TARGET_HANDLE}"]`).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  const url = s.page.url();
  if (/\/i\/flow\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); process.exit(1); }

  // Already following? data-testid ends with -unfollow (the button label is
  // "Following" on hover and "Unfollow" on click). Scope to the target's
  // user-id testid via aria-label so we don't match a sidebar "Who to follow"
  // suggestion's button by accident.
  const unfollowBtn = s.page.locator(`[data-testid$="-unfollow"][aria-label*="${TARGET_HANDLE}"]`).first();
  if (await unfollowBtn.isVisible().catch(() => false)) {
    console.log(`PASS: already following @${TARGET_HANDLE}`);
    process.exit(0);
  }
  // Follow button: testid ends with "-follow", aria-label "Follow @handle".
  // Scope to the target via aria-label to avoid the sidebar suggestion buttons.
  let followBtn = s.page.locator(`[data-testid$="-follow"][aria-label*="${TARGET_HANDLE}"]`).first();
  if (!(await followBtn.isVisible().catch(() => false))) {
    followBtn = s.page.getByRole('button', { name: new RegExp(`^Follow @?${TARGET_HANDLE}$`, 'i') }).first();
  }
  if (!(await followBtn.isVisible().catch(() => false))) {
    const tids = await s.page.evaluate(() => Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')).filter(t => /follow|user/i.test(t ?? '')).slice(0, 10));
    console.log(`FAIL: no Follow button visible at ${url}. visible testids: ${JSON.stringify(tids)}`);
    process.exit(1);
  }
  await humanClickLocator(s.page, followBtn);
  await s.page.waitForTimeout(2000);
  // Verify Follow → Following transition (scoped to target handle).
  const followingBtn = s.page.locator(`[data-testid$="-unfollow"][aria-label*="${TARGET_HANDLE}"]`).filter({ visible: true }).first();
  const ok = await followingBtn.isVisible().catch(() => false);
  if (!ok) { console.log(`FAIL: clicked Follow but no Following state — likely shadowbanned or rate-limited`); process.exit(1); }
  console.log(`PASS: followed @${TARGET_HANDLE}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
