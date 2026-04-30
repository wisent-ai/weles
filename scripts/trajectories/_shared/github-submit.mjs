import { humanFill } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

export async function githubSubmitIssueComment(s, text) {
  // Comment textarea — id=new_comment_field on classic; React UI uses
  // textarea[name="comment[body]"] or [aria-label="Add a comment"].
  const ta = s.page.locator('textarea#new_comment_field, textarea[name="comment[body]"], textarea[aria-label="Add a comment"]').filter({ visible: true }).first();
  await ta.waitFor({ state: 'visible', timeout: 15000 });
  await ta.scrollIntoViewIfNeeded().catch(() => {});
  await humanFill(s.page, ta, text);
  // Submit — primary "Comment" button, not [disabled].
  const submit = s.page.locator('button[type="submit"]:has-text("Comment"):not([disabled]), button[data-disable-with]:not([disabled]):has-text("Comment")').filter({ visible: true }).first();
  await submit.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, submit);
  // Verify state flip — textarea cleared / page advanced (added comment timeline element).
  await s.page.waitForFunction(() => {
    const t = document.querySelector('textarea#new_comment_field, textarea[name="comment[body]"]');
    return !t || (t.value ?? '').length === 0;
  }, { timeout: 15000 }).catch(() => {});
}
