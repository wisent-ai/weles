import { runAction } from '../_shared/action-runner.mjs';
import { instagramSubmitComment } from '../_shared/instagram-submit.mjs';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';

await runAction({
  platform: 'instagram', action: 'organic_comment',
  feedUrl: 'https://www.instagram.com/explore/',
  surfaceLabel: 'instagram explore',
  pickPost: async (s) => {
    try {
      const caption = await s.page.evaluate(() => {
        const el = document.querySelector('article img[alt]') || document.querySelector('img[alt]');
        return el?.getAttribute?.('alt') ?? '';
      });
      return { postTitle: (caption || '').slice(0, 280), postBody: '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  submitComment: instagramSubmitComment,
  banDetector: detectInstagramBanSignals,
});
