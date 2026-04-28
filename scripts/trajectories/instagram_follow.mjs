import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';

const TARGET_USER = (process.env.TARGET_USER || 'wisent.ai').replace(/^@/, '');
const URL = `https://www.instagram.com/${encodeURIComponent(TARGET_USER)}/`;

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_follow', proxy: proxyUrl, persona });

try {
  // Cookie-first auth — Instagram's profile page shows a Follow button only
  // for authed sessions. The agent-loop variant gave up at 'not logged in,
  // inject cookies' because it never injected anything.
  const stored = (acct.metadata?.cookies ?? []).filter(c => /instagram\.com/.test(c.domain ?? ''));
  if (!stored.length) { console.log('FAIL: no instagram cookies — login first'); process.exit(1); }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto(URL, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(5000);
  const url = s.page.url();
  if (/\/accounts\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); process.exit(1); }

  // The Follow button on a profile page is rendered as <button>Follow</button>
  // inside the profile header. After click it becomes <button>Following</button>
  // — verify the text-state transition. If already following, exit healthy.
  const followBtn = s.page.locator('button').filter({ hasText: /^\s*Follow\s*$/ }).filter({ visible: true }).first();
  const followingBtn = s.page.locator('button').filter({ hasText: /^\s*Following\s*$/ }).filter({ visible: true }).first();
  const alreadyFollowing = await followingBtn.count().catch(() => 0);
  if (alreadyFollowing > 0) { console.log(`PASS: already following @${TARGET_USER}`); process.exit(0); }
  await followBtn.waitFor({ state: 'visible' });
  await followBtn.click();
  await s.page.waitForTimeout(3000);
  // Verify transition: Follow → Following
  const after = await s.page.locator('button').filter({ hasText: /^\s*Following\s*$/ }).filter({ visible: true }).count().catch(() => 0);
  if (after === 0) { console.log(`FAIL: clicked Follow but no transition to Following — may be shadowbanned or rate-limited`); process.exit(1); }
  console.log(`PASS: followed @${TARGET_USER}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
