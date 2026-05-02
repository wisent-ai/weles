import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

/**
 * Navigate to a video page from the current feed/profile, then submit a
 * comment. TikTok's /foryou feed uses an immersive video player where the
 * right-rail action bar (comment icon, like button, etc.) frequently fails to
 * hydrate — the same render-shadow that tiktok_like works around by navigating
 * to a profile → video page first. On a dedicated /video/ page the right rail
 * always mounts, so the comment icon and input are reliably present.
 *
 * If the page is already on a /video/ URL with a visible comment icon, we
 * skip the navigation and go straight to commenting.
 */
export async function tiktokSubmitComment(s, text) {
  let currentUrl = s.page.url?.() ?? '';

  // If we're not already on a video page, navigate to one. Strategy:
  // 1. If on a profile page (@user), click the first video link.
  // 2. If on /foryou or /following, navigate to @tiktok (always has videos)
  //    and click through to a video page.
  // TikTok's /foryou immersive player frequently fails to hydrate the
  // right-rail action bar (comment icon, like button, etc.) — same
  // render-shadow as tiktok_like. On a dedicated /video/ page the right
  // rail always mounts, so the comment icon and input are reliably present.
  const onVideoPage = /\/video\/\d+/.test(currentUrl);
  if (!onVideoPage) {
    const isProfile = /\/@[^/?#]+$/.test(currentUrl.split('?')[0]);
    let gridLoaded = false;
    let profileHandles = ['tiktok', 'spotify', 'nba'];
    if (!isProfile) {
      // /foryou itself doesn't expose direct /video/N anchors, but the
      // sidebar of each video lists the AUTHOR's profile anchor (/@user).
      // Scrape those author handles from the current /foryou page and use
      // them as candidate profiles — TikTok's video-listing API is more
      // reliable for the small-creator profiles it just recommended us
      // than for the canonical high-volume handles (@tiktok / @nba).
      let authorHandles = [];
      try {
        if (!/\/foryou/.test(currentUrl)) await s.goto('https://www.tiktok.com/foryou');
        await s.page.waitForTimeout(5000);
        authorHandles = await s.page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('a[href*="/@"]')).map(a => { const m = (a.getAttribute('href')||'').match(/\/@([^/?#]+)/); return m ? m[1] : null; }).filter(Boolean))].slice(0, 5));
        console.log(`[tiktok-submit] /foryou recommended authors: ${JSON.stringify(authorHandles)}`);
      } catch { /* fall through */ }
      profileHandles = [...authorHandles, 'tiktok', 'spotify', 'nba'];
    }
    outer: for (const handle of profileHandles) {
      const profileUrl = `https://www.tiktok.com/@${handle}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        await s.goto(profileUrl);
        const firstVideo = s.page.locator('a[href*="/video/"]').first();
        gridLoaded = await firstVideo.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
        if (gridLoaded) { console.log(`[tiktok-submit] @${handle} grid loaded on attempt ${attempt + 1}`); currentUrl = profileUrl; break outer; }
        console.log(`[tiktok-submit] @${handle} attempt ${attempt + 1}: grid not loaded`);
      }
    }
    if (!gridLoaded) {
      const bodyLen = await s.page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
      throw new Error(`tiktok_comment: no candidate profile rendered video grid (bodyLen=${bodyLen})`);
    }
    // Click through to a video page. Try up to 4 videos in case the first
    // doesn't hydrate the right rail (same pattern as tiktok_like).
    const videoLinks = await s.page.locator('a[href*="/video/"]').all();
    const candidates = videoLinks.slice(0, Math.min(4, videoLinks.length));
    console.log(`[tiktok-submit] found ${candidates.length} video links on profile`);
    let landed = false;
    for (let i = 0; i < candidates.length; i++) {
      const link = candidates[i];
      const href = await link.getAttribute('href').catch(() => '');
      console.log(`[tiktok-submit] trying video ${i + 1}/${candidates.length}: ${href}`);
      try {
        await humanClickLocator(s.page, link);
        await s.page.waitForURL(/\/video\/\d+/, { timeout: 15000 }).catch(() => {});
        // Wait for the right rail to hydrate (comment icon appears).
        const commentIconProbe = s.page.locator('[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]').filter({ visible: true }).first();
        const found = await commentIconProbe.waitFor({ state: 'visible', timeout: 25000 }).then(() => true).catch(() => false);
        if (found) {
          console.log(`[tiktok-submit] comment icon hydrated on video ${i + 1}`);
          landed = true;
          break;
        }
        console.log(`[tiktok-submit] video ${i + 1} did not hydrate comment icon — retrying`);
      } catch (e) {
        console.log(`[tiktok-submit] video ${i + 1} click failed: ${e.message?.slice(0, 80)}`);
      }
      // Go back to profile to try next video.
      if (i < candidates.length - 1) {
        await s.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await s.page.waitForTimeout(2000);
        // Wait for profile grid to re-render.
        await s.page.locator('a[href*="/video/"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      }
    }
    if (!landed) throw new Error('tiktok_comment: could not reach a video page with a visible comment icon');
  }

  // Comment toggle — sidebar icon with data-e2e="comment-icon" / "browse-comment-icon".
  const commentIcon = s.page.locator('[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"], [data-e2e="feed-comment-icon"]').filter({ visible: true }).first();
  if (await commentIcon.count()) {
    await humanClickLocator(s.page, commentIcon);
    await s.page.waitForTimeout(2000);
  }
  // Comment input — TikTok uses a contenteditable div with class containing
  // "DraftEditor" or div[role="textbox"]. Modern selector: data-e2e="comment-input".
  const input = s.page.locator('[data-e2e="comment-input"], div[contenteditable="true"][role="textbox"], div.DraftEditor-editorContainer div[contenteditable="true"]').filter({ visible: true }).first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, input);
  await humanType(s.page, text);
  // Post button — data-e2e="comment-post" once input is non-empty.
  const post = s.page.locator('[data-e2e="comment-post"]:not([aria-disabled="true"]), button[data-e2e="comment-post"]').filter({ visible: true }).first();
  await post.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, post);
  await s.page.waitForFunction(() => {
    const e = document.querySelector('[data-e2e="comment-input"], div[contenteditable="true"][role="textbox"]');
    return !e || (e.textContent ?? '').trim().length === 0;
  }, { timeout: 15000 }).catch(() => {});
}

export async function tiktokSubmitPost(s, text) {
  // TikTok's web upload page is /upload, with file picker → caption → post.
  // Without a video file the trajectory can't post — fail explicitly.
  throw new Error('tiktok_post_not_supported: TikTok requires a video upload; this trajectory does not generate one');
}
