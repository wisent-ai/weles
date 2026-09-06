import { runAction } from '../_shared/action-runner.mjs';
import { detectTikTokBanSignals } from '../../../dist/platforms/tiktok/ban_signals.js';

await runAction({
  platform: 'tiktok', action: 'browse',
  feedUrl: 'https://www.tiktok.com/foryou', scrolls: 12,
  banDetector: detectTikTokBanSignals,
});
