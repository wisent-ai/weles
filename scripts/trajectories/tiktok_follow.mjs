import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from './_shared/auth-probe.mjs';

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
  if (/\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); await markCookiesStale(acct.id); process.exit(1); }

  // TikTok doesn't redirect logged-out users to /login — it just renders the
  // profile page without the follow button. Detect this by checking for the
  // sessionid cookie (proof of valid session). No sessionid = cookies stale.
  // sessionid is httpOnly so document.cookie can't see it — read via the
  // browser context API.
  const ctxCookies = await s.ctx.cookies();
  const hasSessionId = ctxCookies.some(c => c.name === 'sessionid' && (c.domain || '').includes('tiktok'));
  if (!hasSessionId) {
    console.log('FAIL: cookies stale (no sessionid) — login first');
    await markCookiesStale(acct.id);
    process.exit(1);
  }

  // Positive auth probe — sessionid in jar ≠ session is authed server-side.
  // See _shared/auth-probe.mjs for the rationale. Marks cookies stale on
  // failure so the next routine tick enqueues a fresh login.
  try {
    await assertAuthed('tiktok', s, { label: 'tiktok_follow' });
  } catch (probeErr) {
    if (probeErr instanceof AuthProbeError) {
      console.log(`FAIL: ${probeErr.message}`);
      await markCookiesStale(acct.id);
      process.exit(1);
    }
    throw probeErr;
  }

  // Profile page Follow button: <button data-e2e="follow-button"> on web.
  // After click data-e2e becomes "follow-icon" (Following) or text changes.
  const followBtn = s.page.locator('button[data-e2e="follow-button"]').filter({ visible: true }).first();
  const followingBtn = s.page.locator('button[data-e2e="follow-icon"], button:has-text("Following")').filter({ visible: true }).first();
  const alreadyFollowing = await followingBtn.count().catch(() => 0);
  if (alreadyFollowing > 0) { console.log(`PASS: already following @${TARGET_USER}`); process.exit(0); }
  await followBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, followBtn);
  await humanIdlePause('deliberate');
  // TikTok's follow XHR can take 3-8s; wait up to 15s with polling for the
  // state flip rather than a single check at 1s.
  let flipped = false;
  for (let i = 0; i < 30; i++) {
    await s.page.waitForTimeout(500);
    const after = await s.page.locator('button[data-e2e="follow-icon"], button:has-text("Following")').filter({ visible: true }).count().catch(() => 0);
    if (after > 0) { flipped = true; break; }
  }
  if (!flipped) { console.log('FAIL: clicked Follow but state did not flip'); process.exit(1); }
  console.log(`PASS: followed @${TARGET_USER}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
