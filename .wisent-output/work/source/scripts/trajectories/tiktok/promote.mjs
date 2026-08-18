import { runAction } from '../_shared/action-runner.mjs';
import { tiktokSubmitComment } from '../_shared/tiktok-submit.mjs';
import { detectTikTokBanSignals } from '../../../dist/platforms/tiktok/ban_signals.js';

await runAction({
  platform: 'tiktok', action: 'promote',
  feedUrl: 'https://www.tiktok.com/foryou',
  surfaceLabel: 'tiktok fyp',
  resolveUserUrl: (u) => `https://www.tiktok.com/@${u.replace(/^@/, '')}`,
  resolveSearchUrl: (q) => `https://www.tiktok.com/tag/${encodeURIComponent(q.replace(/^#/, ''))}`,
  pickPost: async (s) => {
    try {
      const caption = await s.page.evaluate(() => {
        const el = document.querySelector('[data-e2e="video-desc"], [data-e2e="browse-video-desc"]');
        return el?.textContent ?? '';
      });
      return { postTitle: (caption || '').slice(0, 280), postBody: '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  submitComment: tiktokSubmitComment,
  submitTargetedComment: tiktokSubmitComment,
  banDetector: detectTikTokBanSignals,
});
