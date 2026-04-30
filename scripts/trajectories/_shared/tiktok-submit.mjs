import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

export async function tiktokSubmitComment(s, text) {
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
