import { runAction } from '../_shared/action-runner.mjs';
import { declaredObservation } from '../_shared/observation.mjs';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';

// The origin and the dwell budget are declaration content: admission resolved
// instagram.browse before this process existed. Nothing here names a URL.
const observed = declaredObservation();

await runAction({
  platform: 'instagram', action: 'browse',
  feedUrl: observed.origin, scrolls: observed.scrolls, dwellMs: observed.dwellMs,
  banDetector: detectInstagramBanSignals,
});
