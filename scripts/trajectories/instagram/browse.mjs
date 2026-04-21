import { runAction } from '../_shared/action-runner.mjs';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';

await runAction({
  platform: 'instagram', action: 'browse',
  feedUrl: 'https://www.instagram.com/explore/', scrolls: 10,
  banDetector: detectInstagramBanSignals,
});
