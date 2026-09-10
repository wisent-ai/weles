import { runAction } from '../../../_shared/action-runner.mjs';
import { declaredObservation } from '../../../_shared/observation.mjs';
import { detectTikTokBanSignals } from '../../../../../dist/platforms/tiktok/ban_signals.js';

// The origin and the dwell budget are declaration content: admission resolved
// tiktok.browse before this process existed. Nothing here names a URL.
const observed = declaredObservation();

await runAction({
  platform: 'tiktok', action: 'browse',
  feedUrl: observed.origin, scrolls: observed.scrolls, dwellMs: observed.dwellMs,
  banDetector: detectTikTokBanSignals,
});
