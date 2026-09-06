import { runAction } from '../_shared/action-runner.mjs';
import { twitterSubmitReply } from '../_shared/twitter-submit.mjs';
import { detectTwitterBanSignals } from '../../../dist/platforms/twitter/ban_signals.js';

await runAction({
  platform: 'twitter', action: 'promote',
  feedUrl: 'https://x.com/home',
  surfaceLabel: 'x.com feed',
  resolveUserUrl: (u) => `https://x.com/${u.replace(/^@/, '')}`,
  resolveSearchUrl: (q) => `https://x.com/hashtag/${encodeURIComponent(q.replace(/^#/, ''))}`,
  pickPost: async (s) => {
    const r = s.capturedResponses.find(r => /HomeLatestTimeline|HomeTimeline|UserTweets|TweetDetail|SearchTimeline/.test(r.url));
    try {
      const tweets = JSON.stringify(JSON.parse(r?.body ?? '{}')).match(/"full_text":"([^"]{20,280})"/g)?.slice(0, 10) ?? [];
      const pick = tweets[Math.floor(Math.random() * tweets.length)] ?? '';
      return { postTitle: pick.replace(/^"full_text":"/, '').replace(/"$/, '').slice(0, 280), postBody: '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  submitComment: twitterSubmitReply,
  submitTargetedComment: twitterSubmitReply,
  banDetector: detectTwitterBanSignals,
});
