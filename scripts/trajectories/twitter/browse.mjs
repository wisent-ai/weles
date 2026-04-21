import { runAction } from '../_shared/action-runner.mjs';
import { detectTwitterBanSignals } from '../../../dist/platforms/twitter/ban_signals.js';

await runAction({
  platform: 'twitter', action: 'browse',
  feedUrl: 'https://x.com/home', scrolls: 8,
  banDetector: detectTwitterBanSignals,
});
