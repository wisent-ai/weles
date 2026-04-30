import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

export async function linkedinSubmitComment(s, text) {
  // First post container.
  const post = s.page.locator('div.feed-shared-update-v2, div.fie-impression-container, [data-id^="urn:li:activity"]').first();
  await post.waitFor({ state: 'visible', timeout: 15000 });
  await post.scrollIntoViewIfNeeded().catch(() => {});
  // Comment button — aria-label="Comment".
  const commentBtn = post.locator('button[aria-label="Comment"], button[aria-label*="comment" i]:not([aria-label*="React" i])').filter({ visible: true }).first();
  await commentBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, commentBtn);
  // Editor — contenteditable div with role="textbox" inside the comments section.
  const editor = post.locator('div[role="textbox"][contenteditable="true"], div.ql-editor[contenteditable="true"]').filter({ visible: true }).first();
  await editor.waitFor({ state: 'visible', timeout: 10000 });
  await humanClickLocator(s.page, editor);
  await humanType(s.page, text);
  // Post submit button — once text is entered, button[disabled] flips.
  const postBtn = post.locator('button.comments-comment-box__submit-button:not([disabled]), button:has-text("Post"):not([disabled])').filter({ visible: true }).first();
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
  await s.page.waitForTimeout(3500);
  // Compose share button — top of feed.
  const startPost = s.page.locator('button.share-box-feed-entry__trigger, button:has-text("Start a post"), [aria-label="Start a post"]').filter({ visible: true }).first();
  await startPost.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, startPost);
  const editor = s.page.locator('div[role="textbox"][contenteditable="true"], div.ql-editor[contenteditable="true"]').filter({ visible: true }).first();
  await editor.waitFor({ state: 'visible', timeout: 10000 });
  await humanClickLocator(s.page, editor);
  await humanType(s.page, text);
  const postBtn = s.page.locator('div.share-box_actions button.share-actions__primary-action:not([disabled]), button:has-text("Post"):not([disabled])').filter({ visible: true }).first();
  await postBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, postBtn);
  await s.page.waitForFunction(() => !document.querySelector('div[role="dialog"][role="dialog"] div.ql-editor[contenteditable="true"]'), { timeout: 20000 }).catch(() => {});
}
