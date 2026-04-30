import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectInstagramBanSignals } from '../../../../dist/platforms/instagram/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_URL  = process.env.TARGET_URL || '';
const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');
const SEARCH_QUERY = (process.env.SEARCH_QUERY || '').replace(/^#/, '');

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_like', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /instagram\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  let url;
  if (TARGET_URL) url = TARGET_URL;
  else if (TARGET_USER) url = `https://www.instagram.com/${encodeURIComponent(TARGET_USER)}/`;
  else if (SEARCH_QUERY) url = `https://www.instagram.com/explore/tags/${encodeURIComponent(SEARCH_QUERY)}/`;
  else url = 'https://www.instagram.com/explore/';
  await s.goto(url);
  checkReachable(s, 'instagram');
  await s.page.waitForTimeout(3500);
  // If we're on a grid (profile, explore, hashtag), the page has a wall of
  // post-thumbnail anchors a[href^="/p/"] / a[href^="/reel/"]. Open the
  // first one to land on a single-post URL where the like button is stable.
  if (!/\/p\/|\/reel\//.test(s.page.url())) {
    const thumb = s.page.locator('a[href*="/p/"], a[href*="/reel/"]').filter({ visible: true }).first();
    await thumb.waitFor({ state: 'visible' });
    const href = await thumb.getAttribute('href');
    if (href) {
      const postUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
      await s.goto(postUrl);
      await s.page.waitForTimeout(3000);
    } else {
      await humanClickLocator(s.page, thumb);
      await s.page.waitForTimeout(3000);
    }
  }
  // Like button: <svg aria-label="Like"> inside a clickable parent. Click
  // the closest role="button" ancestor (or the svg's parent <div> in older
  // markup). State flip: aria-label changes from "Like" to "Unlike".
  const likeSvg = s.page.locator('svg[aria-label="Like"]').filter({ visible: true }).first();
  if (!(await likeSvg.count())) {
    // Already liked — idempotent PASS
    ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already liked`);
  } else {
    // Click the parent button/div, not the svg itself (svg has pointer-events:none).
    const likeBtn = likeSvg.locator('xpath=ancestor::*[self::button or self::div[@role="button"] or @role="button"][1]').first();
    await likeBtn.scrollIntoViewIfNeeded().catch(() => {});
    await humanClickLocator(s.page, likeBtn);
    await s.page.locator('svg[aria-label="Unlike"]').first().waitFor({ state: 'visible' });
    ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: liked`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'instagram_like'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'instagram_like', target_url: TARGET_URL, target_user: TARGET_USER, search_query: SEARCH_QUERY, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
