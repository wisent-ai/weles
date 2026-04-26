import { runAction } from '../_shared/action-runner.mjs';
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
  commentGoal: (text) => `On x.com home timeline. Use js_click(selector="[data-testid='reply']") to open the reply composer for the first tweet (Twitter's Reply button has data-testid='reply' — direct selector beats vision). Wait 2 seconds. fill(target="Post your reply", value=${JSON.stringify(text)}). Then js_click(selector="[data-testid='tweetButton']") to submit. done(value="promoted"). Do NOT navigate(). Do NOT give_up.`,
  targetedCommentGoal: (text) => `On a specific x.com tweet/profile/hashtag page. Use js_click(selector="[data-testid='reply']") to open the reply composer (Twitter Reply has data-testid='reply'). Wait 2 seconds. fill(target="Post your reply", value=${JSON.stringify(text)}). Then js_click(selector="[data-testid='tweetButton']") to submit. done(value="promoted"). Do NOT navigate(). Do NOT give_up.`,
  banDetector: detectTwitterBanSignals,
});
