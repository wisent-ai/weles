import { runAction } from '../../../_shared/action-runner.mjs';
import { tiktokSubmitComment } from '../../submit.mjs';
import { detectTikTokBanSignals } from '../../../../../dist/platforms/tiktok/ban_signals.js';

await runAction({
  platform: 'tiktok',
  action: 'organic_comment',
  feedUrl: 'https://www.tiktok.com/foryou',
  surfaceLabel: 'tiktok fyp',
  // The video's whole caption; a page without one is refused (runAction logs it).
  pickPost: async (s) => {
    const caption = s.page
      .locator('[data-e2e="video-desc"], [data-e2e="browse-video-desc"]')
      .first();
    if (!(await caption.count()))
      throw new Error('the page shows no video caption to answer');
    return { postTitle: await caption.innerText(), postBody: '' };
  },
  submitComment: tiktokSubmitComment,
  banDetector: detectTikTokBanSignals,
});
