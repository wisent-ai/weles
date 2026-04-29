import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator } from '../../dist/human/mouse.js';

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
  if (/\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); await markCookiesStale(acct.id); process.exit(1); }
  // TikTok doesn't redirect logged-out users to /login — it just renders the
  // page without action affordances. Detect via sessionid cookie.
  const hasSessionId = await s.page.evaluate(() => document.cookie.includes('sessionid'));
  if (!hasSessionId) {
    console.log('FAIL: cookies stale (no sessionid) — login first');
    await markCookiesStale(acct.id);
    process.exit(1);
  }

  // The right-rail like button on each video is <button aria-label^="Like
  // video">. aria-pressed='false' before click, 'true' after a registered
  // like. Filter to first visible — the FYP renders 2-3 videos but only one
  // is on-screen.
  const likeBtn = s.page.locator('button[aria-label^="Like video"]').filter({ visible: true }).first();
  await likeBtn.waitFor({ state: 'visible' });
  const before = await likeBtn.getAttribute('aria-pressed');
  await likeBtn.scrollIntoViewIfNeeded();
  // Capture the digg XHR response so a failure path emits status+body, not
  // just "aria-pressed did not flip". TikTok's UI swallows soft-rejects:
  // a 200 with status_code != 0 in the body is a silent shadowban; a 200
  // with status_code == 0 but action not registered is a fingerprint flag;
  // a 4xx is auth/cookie failure. Without this capture every failure looked
  // identical.
  let diggResp = null;
  s.page.on('response', async (resp) => {
    if (!/\/aweme\/v[12]\/(commit\/item\/digg|aweme\/digg)/.test(resp.url())) return;
    try { diggResp = { status: resp.status(), url: resp.url(), body: (await resp.text()).slice(0, 400) }; } catch {}
  });
  await humanClickLocator(s.page, likeBtn);
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
