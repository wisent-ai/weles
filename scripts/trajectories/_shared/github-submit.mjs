import { humanFill } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

export async function githubSubmitIssueComment(s, text) {
  // Comment textarea — id=new_comment_field on classic; React UI uses
  // textarea[name="comment[body]"] or [aria-label="Add a comment"].
  // GitHub migrated issues to the Primer/React composer: textarea wrapped in
  // [data-testid="comment-composer"], referenced by aria-labelledby
  // "comment-composer-heading", placeholder "Use Markdown to format your
  // comment", auto-generated id (e.g. _r_22_). Classic shell (#new_comment_field,
  // name="comment[body]") still ships for some repos / unauth views — keep
  // those in the selector union.
  const ta = s.page.locator('[data-testid="comment-composer"] textarea, textarea[aria-labelledby="comment-composer-heading"], textarea[placeholder*="Use Markdown to format your comment"], textarea#new_comment_field, textarea[name="comment[body]"], textarea[aria-label="Add a comment"]').filter({ visible: true }).first();
  await ta.waitFor({ state: 'visible', timeout: 15000 });
  await ta.scrollIntoViewIfNeeded().catch(() => {});
  await humanFill(s.page, ta, text);
  // Submit — primary "Comment" button, not [disabled]. Primer composer uses
  // type="button" (not "submit") wrapped in [data-testid="save-button-tooltip"]
  // with data-variant="primary"; classic shell uses type="submit". Match both.
  const submit = s.page.locator('[data-testid="save-button-tooltip"] button[data-variant="primary"]:not([disabled]), [data-testid="comment-composer"] button[data-variant="primary"]:not([disabled]), button[type="submit"]:has-text("Comment"):not([disabled]), button[data-disable-with]:not([disabled]):has-text("Comment")').filter({ visible: true }).first();
  await submit.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, submit);
  // Verify state flip — textarea cleared / page advanced (added comment timeline element).
  await s.page.waitForFunction(() => {
    const t = document.querySelector('[data-testid="comment-composer"] textarea, textarea[aria-labelledby="comment-composer-heading"], textarea#new_comment_field, textarea[name="comment[body]"]');
    return !t || (t.value ?? '').length === 0;
  }, { timeout: 15000 }).catch(() => {});
}
