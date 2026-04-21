import { runAction } from '../_shared/action-runner.mjs';
import { detectTwitterBanSignals } from '../../../dist/platforms/twitter/ban_signals.js';

await runAction({
  platform: 'twitter', action: 'promote',
  feedUrl: 'https://x.com/home',
  surfaceLabel: 'x.com feed',
  pickPost: async (s) => {
    const r = s.capturedResponses.find(r => /HomeLatestTimeline|HomeTimeline/.test(r.url));
    try {
      const tweets = JSON.stringify(JSON.parse(r?.body ?? '{}')).match(/"full_text":"([^"]{20,280})"/g)?.slice(0, 10) ?? [];
      const pick = tweets[Math.floor(Math.random() * tweets.length)] ?? '';
      return { postTitle: pick.replace(/^"full_text":"/, '').replace(/"$/, '').slice(0, 280), postBody: '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  commentGoal: (text) => `Find a tweet on the home timeline. Click its Reply button. In the reply composer, fill(target="Post your reply", value=${JSON.stringify(text)}). Then click Reply to submit. done(value="promoted"). Do NOT navigate() beyond the reply modal. Do NOT give_up.`,
  banDetector: detectTwitterBanSignals,
});
