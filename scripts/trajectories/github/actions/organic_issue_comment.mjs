import { runAction } from '../../_shared/action-runner.mjs';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';

const ISSUE_URL = process.env.ISSUE_URL;
if (!ISSUE_URL) { console.log('FAIL: ISSUE_URL required (e.g. https://github.com/org/repo/issues/123)'); process.exit(1); }

// action name MUST match the action_action_logs.action so the worker
// reads ban_signal.json from the right recordings/<label>/ directory.
// Pre-fix: trajectory used action='organic_comment' → label github_organic_comment,
// but worker action='github_organic_issue_comment' → reading wrong path,
// causing every result to fall back to 'unknown_error'.
await runAction({
  platform: 'github', action: 'organic_issue_comment',
  feedUrl: ISSUE_URL,
  surfaceLabel: 'github issue',
  pickPost: async (s) => {
    try {
      const title = await s.page.evaluate(() => document.querySelector('bdi.js-issue-title, .js-issue-title')?.textContent?.trim() ?? '');
      const body = await s.page.evaluate(() => document.querySelector('.markdown-body')?.textContent?.trim().slice(0, 600) ?? '');
      return { postTitle: title || '', postBody: body || '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  commentGoal: (text) => `On a GitHub issue page. Use js_click(selector="textarea#new_comment_field, textarea[name='comment[body]'], textarea[aria-label='Add a comment']") to focus the comment textarea. Wait 1 second. fill(target="Leave a comment", value=${JSON.stringify(text)}). js_click(selector="button:has-text('Comment'):not([disabled]), button[type='submit'][data-disable-with]:not([disabled])"). done(value="commented"). Do NOT navigate(). Do NOT give_up.`,
  banDetector: detectGitHubBanSignals,
});
