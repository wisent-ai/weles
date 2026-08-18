import { runAction } from '../../_shared/action-runner.mjs';
import { humanType, humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../../../dist/platforms/reddit/ban_signals.js';

const ACTION = process.env.POST_PROMOTE === '1' ? 'post_promote' : 'post';
const SUBREDDIT = (process.env.SUBREDDIT || '').replace(/^r\//, '');
if (!SUBREDDIT) { console.log('FAIL: SUBREDDIT required for reddit submit'); process.exit(1); }

await runAction({
  platform: 'reddit',
  action: ACTION,
  // Use old.reddit.com for submission — same deterministic
  // textarea/button.save pattern as reddit_comment.mjs.
  feedUrl: `https://old.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/submit?selftext=true`,
  banDetector: detectRedditBanSignals,
  surfaceLabel: `r/${SUBREDDIT}`,
  submitPost: async (s, text) => {
    const idx = text.indexOf('.');
    const title = (idx > 5 && idx < 120 ? text.slice(0, idx) : text.slice(0, 100)).trim();
    const body  = (idx > 5 ? text.slice(idx + 1) : '').trim();
    const titleIn = s.page.locator('input[name="title"], textarea[name="title"]').filter({ visible: true }).first();
    await titleIn.waitFor({ state: 'visible', timeout: 15000 });
    await humanFill(s.page, titleIn, title);
    const bodyIn = s.page.locator('textarea[name="text"]').filter({ visible: true }).first();
    if (await bodyIn.count() && body) {
      await humanClickLocator(s.page, bodyIn);
      await humanType(s.page, body);
    }
    // old.reddit's Submit button is button.btn within the submit form.
    const submitBtn = s.page.locator('form#newlink button.btn[type="submit"], button.btn:has-text("submit")').filter({ visible: true }).first();
    await submitBtn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, submitBtn);
    await s.page.waitForFunction((sub) => /\/comments\//.test(location.pathname) && new RegExp(`/r/${sub}/`, 'i').test(location.pathname), SUBREDDIT, { timeout: 30000 });
  },
});
