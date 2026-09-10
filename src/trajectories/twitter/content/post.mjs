import { runAction } from '../../_shared/action-runner.mjs';
import { twitterSubmitPost } from '../../_shared/twitter-submit.mjs';
import { detectTwitterBanSignals } from '../../../../dist/platforms/twitter/ban_signals.js';

// action-runner dispatches on cfg.action: 'post' (organic) or 'post_promote'
// (woven product mention). The lifecycle scheduler picks which by routing
// twitter_post (organic menu) vs twitter_post_promote (promote menu).
const ACTION = process.env.POST_PROMOTE === '1' ? 'post_promote' : 'post';

await runAction({
  platform: 'twitter',
  action: ACTION,
  feedUrl: 'https://x.com/home',
  banDetector: detectTwitterBanSignals,
  surfaceLabel: 'x (twitter)',
  submitPost: twitterSubmitPost,
});
