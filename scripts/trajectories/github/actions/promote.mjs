import { runAction } from '../../_shared/action-runner.mjs';
import { githubSubmitIssueComment } from '../../_shared/github-submit.mjs';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';

const ISSUE_URL = process.env.ISSUE_URL;
if (!ISSUE_URL) { console.log('FAIL: ISSUE_URL required (e.g. https://github.com/org/repo/issues/123)'); process.exit(1); }

await runAction({
  platform: 'github', action: 'promote',
  feedUrl: ISSUE_URL,
  surfaceLabel: 'github issue',
  pickPost: async (s) => {
    try {
      const title = await s.page.evaluate(() => document.querySelector('bdi.js-issue-title, .js-issue-title')?.textContent?.trim() ?? '');
      const body = await s.page.evaluate(() => document.querySelector('.markdown-body')?.textContent?.trim().slice(0, 600) ?? '');
      return { postTitle: title || '', postBody: body || '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  submitComment: githubSubmitIssueComment,
  banDetector: detectGitHubBanSignals,
});
