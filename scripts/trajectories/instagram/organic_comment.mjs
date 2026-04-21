import { runAction } from '../_shared/action-runner.mjs';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';

await runAction({
  platform: 'instagram', action: 'organic_comment',
  feedUrl: 'https://www.instagram.com/explore/',
  surfaceLabel: 'instagram explore',
  pickPost: async (s) => {
    // Grab a caption from the first post visible in the DOM.
    try {
      const caption = await s.page.evaluate(() => {
        const el = document.querySelector('article img[alt]') || document.querySelector('img[alt]');
        return el?.getAttribute?.('alt') ?? '';
      });
      return { postTitle: (caption || '').slice(0, 280), postBody: '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  commentGoal: (text) => `Click the first post in the explore grid to open it. Find the comment input (placeholder "Add a comment..."). fill(target="add a comment", value=${JSON.stringify(text)}). Click Post to submit. done(value="commented"). Do NOT navigate() beyond the post modal. Do NOT give_up.`,
  banDetector: detectInstagramBanSignals,
});
