import { runAction } from '../_shared/action-runner.mjs';
import { linkedinSubmitComment } from '../_shared/linkedin-submit.mjs';
import { detectLinkedInBanSignals } from '../../../dist/platforms/linkedin/ban_signals.js';

await runAction({
  platform: 'linkedin', action: 'promote',
  feedUrl: 'https://www.linkedin.com/feed/',
  surfaceLabel: 'linkedin feed',
  resolveUserUrl: (u) => `https://www.linkedin.com/in/${u.replace(/^@/, '')}/`,
  resolveSearchUrl: (q) => `https://www.linkedin.com/feed/hashtag/${encodeURIComponent(q.replace(/^#/, ''))}/`,
  pickPost: async (s) => {
    try {
      const text = await s.page.evaluate(() => {
        const el = document.querySelector('.feed-shared-update-v2__description, .update-components-text');
        return el?.textContent?.trim() ?? '';
      });
      return { postTitle: (text || '').slice(0, 400), postBody: '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  submitComment: linkedinSubmitComment,
  submitTargetedComment: linkedinSubmitComment,
  banDetector: detectLinkedInBanSignals,
});
