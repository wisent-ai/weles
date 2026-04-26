import { runAction } from '../_shared/action-runner.mjs';
import { detectTwitterBanSignals } from '../../../dist/platforms/twitter/ban_signals.js';

// action MUST match action_action_logs.action so worker reads ban_signal.json
// from recordings/twitter_organic_reply/ — same label-mismatch class as the
// github_organic_issue_comment fix.
await runAction({
  platform: 'twitter', action: 'organic_reply',
  feedUrl: 'https://x.com/home',
  surfaceLabel: 'x.com feed',
  pickPost: async (s) => {
    const r = s.capturedResponses.find(r => /HomeLatestTimeline|HomeTimeline/.test(r.url));
    try {
      const data = JSON.parse(r?.body ?? '{}');
      const tweets = JSON.stringify(data).match(/"full_text":"([^"]{20,280})"/g)?.slice(0, 10) ?? [];
      const pick = tweets[Math.floor(Math.random() * tweets.length)] ?? '';
      return { postTitle: pick.replace(/^"full_text":"/, '').replace(/"$/, '').slice(0, 280), postBody: '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  commentGoal: (text) => `On x.com home timeline. Use js_click(selector="[data-testid='reply']") to open reply composer (Twitter Reply button has data-testid='reply' — direct selector beats vision). Wait 2 seconds. fill(target="Post your reply", value=${JSON.stringify(text)}). Then js_click(selector="[data-testid='tweetButton']") to submit. done(value="replied"). Do NOT navigate(). Do NOT give_up.`,
  banDetector: detectTwitterBanSignals,
});
