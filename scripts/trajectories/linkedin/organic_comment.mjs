import { runAction } from '../_shared/action-runner.mjs';
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
  commentGoal: (text) => `Find the first post on the feed and click its Comment button. In the comment editor, fill(target="Add a comment", value=${JSON.stringify(text)}). Click Post. done(value="commented"). Do NOT navigate() away. Do NOT give_up.`,
  banDetector: detectLinkedInBanSignals,
});
