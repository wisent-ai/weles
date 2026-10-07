import { runAction } from '../../../_shared/action-runner.mjs';
import { tiktokSubmitComment } from '../../submit.mjs';
import { detectTikTokBanSignals } from '../../../../../dist/platforms/tiktok/ban_signals.js';

await runAction({
  platform: 'tiktok',
  action: 'promote',
  feedUrl: 'https://www.tiktok.com/foryou',
  surfaceLabel: 'tiktok fyp',
  resolveUserUrl: (u) => `https://www.tiktok.com/@${u.replace(/^@/, '')}`,
  resolveSearchUrl: (q) =>
    `https://www.tiktok.com/tag/${encodeURIComponent(q.replace(/^#/, ''))}`,
  // The video's whole caption; a page without one is refused (runAction logs it).
  pickPost: async (s) => ({
    postTitle: await s.page
      .locator('[data-e2e="video-desc"], [data-e2e="browse-video-desc"]')
      .first()
      .innerText(),
    postBody: '',
  }),
  submitComment: tiktokSubmitComment,
  submitTargetedComment: tiktokSubmitComment,
  banDetector: detectTikTokBanSignals,
});
