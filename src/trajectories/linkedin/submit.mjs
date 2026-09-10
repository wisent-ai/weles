import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

export async function linkedinSubmitComment(s, text) {
  // 2026-05-06: legacy container selectors gone in the new design system.
  // Anchor on the React-Like button (semantic + stable) and ascend to its
  // feed-post wrapper. Empty-feed accounts (fresh registrations with no
  // following) get an early benign-no-op so we don't 30s-timeout hunting
  // for a post that won't render.
  const reactLikeCount = await s.page.locator('button[aria-label*="React Like" i]').count();
  if (reactLikeCount === 0) {
    console.log('[linkedin_submit_comment] no_likeable_posts_on_page — feed empty, skipping');
    return;
  }
  const post = s.page.locator('button[aria-label*="React Like" i]').first().locator('xpath=ancestor::*[@data-testid="feed-post" or @data-id or contains(@class, "feed-post") or contains(@class, "update-components")][1]');
  await post.waitFor({ state: 'visible', timeout: 15000 });
  await post.scrollIntoViewIfNeeded().catch(() => {});
  // Comment button — aria-label="Comment".
  const commentBtn = post.locator('button[aria-label="Comment"], button[aria-label*="comment" i]:not([aria-label*="React" i])').filter({ visible: true }).first();
  await commentBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, commentBtn);
  // Editor — wider 2026 set: data-testid editor/composer + legacy Quill +
  // bare contenteditable. Page-scoped because the comment composer can
  // attach outside the post wrapper depending on layout.
  const editor = s.page.locator('[data-testid*="editor"][contenteditable="true"], [data-testid*="composer"][contenteditable="true"], div[role="textbox"][contenteditable="true"], div.ql-editor[contenteditable="true"], [contenteditable="true"]:not([role="combobox"]):not([role="textbox"])').filter({ visible: true }).first();
  await editor.waitFor({ state: 'visible', timeout: 10000 });
  await humanClickLocator(s.page, editor);
  await humanType(s.page, text);
  // Post submit button — once text is entered, button[disabled] flips.
  const postBtn = s.page.locator('button.comments-comment-box__submit-button:not([disabled]), [data-testid*="comment"][role="button"]:not([disabled]):has-text("Post"), button:has-text("Post"):not([disabled])').filter({ visible: true }).first();
  await postBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, postBtn);
  // Verify state flip — editor cleared.
  await s.page.waitForFunction(() => {
    const e = document.querySelector('div[role="textbox"][contenteditable="true"]');
    return !e || (e.textContent ?? '').trim().length === 0;
  }, { timeout: 15000 }).catch(() => {});
}

export async function linkedinSubmitPost(s, text) {
  await s.goto('https://www.linkedin.com/feed/');
  await humanIdlePause('deliberate');
  // Compose share button — top of feed. aria-label="Start a post" is the
  // stable marker (verified 2026-05-06 in captured /feed/ DOM at
  // recordings/linkedin_browse/after_001_goto__dom.html).
  const startPost = s.page.locator('[aria-label="Start a post"], button.share-box-feed-entry__trigger, button:has-text("Start a post")').filter({ visible: true }).first();
  await startPost.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, startPost);
  // 2026-05-06: composer migrated off Quill (.ql-editor / div[role="textbox"]).
  // Match a wider set of editor shapes — data-testid is the stable LinkedIn
  // 2026 attribute; legacy + bare contenteditable kept as fall-throughs.
  const editor = s.page.locator('[data-testid*="editor"][contenteditable="true"], [data-testid*="composer"][contenteditable="true"], div[role="textbox"][contenteditable="true"], div.ql-editor[contenteditable="true"], [contenteditable="true"]:not([role="combobox"]):not([role="textbox"])').filter({ visible: true }).first();
  await editor.waitFor({ state: 'visible', timeout: 10000 });
  await humanClickLocator(s.page, editor);
  await humanType(s.page, text);
  const postBtn = s.page.locator('button.share-actions__primary-action:not([disabled]), [data-testid*="post"][role="button"]:not([disabled]), button:has-text("Post"):not([disabled])').filter({ visible: true }).first();
  await postBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, postBtn);
  await s.page.waitForFunction(() => !document.querySelector('div[role="dialog"][role="dialog"] div.ql-editor[contenteditable="true"]'), { timeout: 20000 }).catch(() => {});
}
