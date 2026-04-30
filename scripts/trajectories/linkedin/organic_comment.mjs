import { runAction } from '../_shared/action-runner.mjs';
import { linkedinSubmitComment } from '../_shared/linkedin-submit.mjs';
import { detectLinkedInBanSignals } from '../../../dist/platforms/linkedin/ban_signals.js';

await runAction({
  platform: 'linkedin', action: 'organic_comment',
  feedUrl: 'https://www.linkedin.com/feed/',
  surfaceLabel: 'linkedin feed',
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
  banDetector: detectLinkedInBanSignals,
});
