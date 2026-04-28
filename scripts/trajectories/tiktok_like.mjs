import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';

const TARGET_URL = process.env.TARGET_URL || 'https://www.tiktok.com/foryou';

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

  await s.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(6000);
  const url = s.page.url();
  if (/\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); process.exit(1); }

  // The right-rail like button on each video is <button aria-label^="Like
  // video">. aria-pressed='false' before click, 'true' after a registered
  // like. Filter to first visible — the FYP renders 2-3 videos but only one
  // is on-screen.
  const likeBtn = s.page.locator('button[aria-label^="Like video"]').filter({ visible: true }).first();
  await likeBtn.waitFor({ state: 'visible' });
  const before = await likeBtn.getAttribute('aria-pressed');
  await likeBtn.scrollIntoViewIfNeeded();
  await likeBtn.click();
  // Poll: TikTok's like XHR can take 3-8s on cold cache; aria-pressed flips
  // only after the API confirms.
  let after = before;
  for (let i = 0; i < 10; i++) {
    await s.page.waitForTimeout(1000);
    after = await likeBtn.getAttribute('aria-pressed').catch(() => null);
    if (after === 'true' && before !== 'true') break;
  }
  if (before === 'true') { console.log('PASS: already liked (aria-pressed was already true)'); }
  else if (after === 'true') { console.log('PASS: liked'); }
  else { console.log(`FAIL: aria-pressed did not flip (before=${before} after=${after}) — likely shadowbanned or rate-limited`); process.exit(1); }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
