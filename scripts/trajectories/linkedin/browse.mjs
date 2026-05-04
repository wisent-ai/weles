import { runAction } from '../_shared/action-runner.mjs';
import { reloginLinkedinInline } from '../_shared/linkedin/relogin.mjs';
import { detectLinkedInBanSignals } from '../../../dist/platforms/linkedin/ban_signals.js';

await runAction({
  platform: 'linkedin', action: 'browse',
  inlineRelogin: reloginLinkedinInline,
  feedUrl: 'https://www.linkedin.com/feed/', scrolls: 8,
  banDetector: detectLinkedInBanSignals,
});
