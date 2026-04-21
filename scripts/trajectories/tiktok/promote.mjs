import { runAction } from '../_shared/action-runner.mjs';
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
  commentGoal: (text) => `Click the comment icon on the current video to open the comment panel. Find the comment input (placeholder "Add comment..."). fill(target="add comment", value=${JSON.stringify(text)}). Click Post to submit. done(value="promoted"). Do NOT navigate(). Do NOT give_up.`,
  targetedCommentGoal: (text) => `You are on a specific TikTok page (user profile, tag, or video). If you see a grid of videos, click the first one to open it. Click the comment icon to open the comment panel. fill(target="add comment", value=${JSON.stringify(text)}). Click Post to submit. done(value="promoted"). Do NOT navigate() away. Do NOT give_up.`,
  banDetector: detectTikTokBanSignals,
});
