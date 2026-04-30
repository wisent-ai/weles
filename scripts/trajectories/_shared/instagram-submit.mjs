import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

// If we're on a grid (explore, profile, hashtag), open first post first.
async function ensureSinglePost(s) {
  if (!/\/p\/|\/reel\//.test(s.page.url())) {
    const thumb = s.page.locator('a[href*="/p/"], a[href*="/reel/"]').filter({ visible: true }).first();
    await thumb.waitFor({ state: 'visible', timeout: 15000 });
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
}

export async function instagramSubmitComment(s, text) {
  await ensureSinglePost(s);
  // Comment textarea — placeholder "Add a comment..." or aria-label "Add a comment...".
  const ta = s.page.locator('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i], form textarea').filter({ visible: true }).first();
  await ta.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, ta);
  // Older IG hides the textarea inside an "Add a comment" placeholder div
  // that becomes a textarea on focus — humanClick already focused, so type.
  await humanType(s.page, text);
  // Post button — Instagram shows a <button type="submit"> with text "Post"
  // (or aria-label "Post comment"). It activates only when text is present.
  const post = s.page.locator('form button[type="submit"]:has-text("Post"), button:has-text("Post"):not([disabled]), button[aria-label="Post comment"]:not([disabled])').filter({ visible: true }).first();
  await post.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, post);
  // Verify state flip — textarea cleared after successful post.
  await s.page.waitForFunction(() => {
    const t = document.querySelector('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i]');
    return !t || (t.value ?? '').length === 0;
  }, { timeout: 15000 }).catch(() => {});
}
