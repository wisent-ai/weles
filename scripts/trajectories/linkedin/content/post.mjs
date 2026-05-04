import { runAction } from '../../_shared/action-runner.mjs';
import { linkedinSubmitPost } from '../../_shared/linkedin-submit.mjs';
import { reloginLinkedinInline } from '../../_shared/linkedin/relogin.mjs';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';

const ACTION = process.env.POST_PROMOTE === '1' ? 'post_promote' : 'post';

await runAction({
  platform: 'linkedin',
  action: ACTION,
  inlineRelogin: reloginLinkedinInline,
  feedUrl: 'https://www.linkedin.com/feed/',
  banDetector: detectLinkedInBanSignals,
  surfaceLabel: 'linkedin',
  submitPost: linkedinSubmitPost,
});
