import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';

const TARGET_USER = (process.env.TARGET_USER || 'tiktok').replace(/^@/, '');
const URL = `https://www.tiktok.com/@${encodeURIComponent(TARGET_USER)}`;

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_follow', proxy: proxyUrl, persona });

try {
  // Cookie-first auth — TikTok requires sessionid + tt-target-idc.
  const stored = (acct.metadata?.cookies ?? []).filter(c => /tiktok\.com/.test(c.domain ?? ''));
  if (!stored.length) { console.log('FAIL: no tiktok cookies — login first'); process.exit(1); }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto(URL, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(6000);
  const url = s.page.url();
  if (/\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); process.exit(1); }

  // Profile page Follow button: <button data-e2e="follow-button"> on web.
  // After click data-e2e becomes "follow-icon" (Following) or text changes.
  const followBtn = s.page.locator('button[data-e2e="follow-button"]').filter({ visible: true }).first();
  const followingBtn = s.page.locator('button[data-e2e="follow-icon"], button:has-text("Following")').filter({ visible: true }).first();
  const alreadyFollowing = await followingBtn.count().catch(() => 0);
  if (alreadyFollowing > 0) { console.log(`PASS: already following @${TARGET_USER}`); process.exit(0); }
  await followBtn.waitFor({ state: 'visible' });
  await followBtn.click();
  await s.page.waitForTimeout(3000);
  const after = await s.page.locator('button[data-e2e="follow-icon"], button:has-text("Following")').filter({ visible: true }).count().catch(() => 0);
  if (after === 0) { console.log('FAIL: clicked Follow but state did not flip'); process.exit(1); }
  console.log(`PASS: followed @${TARGET_USER}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
