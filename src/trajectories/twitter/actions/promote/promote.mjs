import { runAction } from '../../../_shared/action-runner.mjs';
import { twitterSubmitReply } from '../../submit.mjs';
import { detectTwitterBanSignals } from '../../../../../dist/platforms/twitter/ban_signals.js';
import { pickTimelinePost } from '../comment/timeline_post.mjs';

await runAction({
  platform: 'twitter',
  action: 'promote',
  feedUrl: 'https://x.com/home',
  surfaceLabel: 'x.com feed',
  resolveUserUrl: (u) => `https://x.com/${u.replace(/^@/, '')}`,
  resolveSearchUrl: (q) =>
    `https://x.com/hashtag/${encodeURIComponent(q.replace(/^#/, ''))}`,
  pickPost: async (s) =>
    pickTimelinePost(
      s.capturedResponses,
      /HomeLatestTimeline|HomeTimeline|UserTweets|TweetDetail|SearchTimeline/,
    ),
  submitComment: twitterSubmitReply,
  submitTargetedComment: twitterSubmitReply,
  banDetector: detectTwitterBanSignals,
});
