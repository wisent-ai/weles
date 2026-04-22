import { runAction } from '../../_shared/action-runner.mjs';
import { detectTwitterBanSignals } from '../../../../dist/platforms/twitter/ban_signals.js';

// action-runner dispatches on cfg.action: 'post' (organic) or 'post_promote'
// (woven product mention). The lifecycle scheduler picks which by routing
// twitter_post (organic menu) vs twitter_post_promote (promote menu).
const ACTION = process.env.POST_PROMOTE === '1' ? 'post_promote' : 'post';

await runAction({
  platform: 'twitter',
  action: ACTION,
  feedUrl: 'https://x.com/compose/post',
  banDetector: detectTwitterBanSignals,
  surfaceLabel: 'x (twitter)',
  postGoal: (text) => `You are on X's compose-tweet page. The tweet text area should be visible (labelled "What's happening?!" or similar). Do the following:\n1. Click into the tweet text area and type exactly: ${text}\n2. Find the primary Post button (top-right of the compose surface, blue/black, labelled "Post") and click it.\nAfter the modal closes or the URL advances, done(value="posted"). Do NOT navigate() manually. Do NOT add hashtags or additional text.`,
});
