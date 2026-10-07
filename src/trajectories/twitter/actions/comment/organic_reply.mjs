import { runAction } from '../../../_shared/action-runner.mjs';
import { twitterSubmitReply } from '../../submit.mjs';
import { detectTwitterBanSignals } from '../../../../../dist/platforms/twitter/ban_signals.js';
import { pickTimelinePost } from './timeline_post.mjs';

// action MUST match action_action_logs.action so worker reads ban_signal.json
// from recordings/twitter_organic_reply/ — same label-mismatch class as the
// github_organic_issue_comment fix.
await runAction({
  platform: 'twitter',
  action: 'organic_reply',
  feedUrl: 'https://x.com/home',
  surfaceLabel: 'x.com feed',
  pickPost: async (s) =>
    pickTimelinePost(s.capturedResponses, /HomeLatestTimeline|HomeTimeline/),
  submitComment: twitterSubmitReply,
  banDetector: detectTwitterBanSignals,
});
