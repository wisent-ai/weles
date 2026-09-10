import { runAction } from '../../../_shared/action-runner.mjs';
import { declaredObservation } from '../../../_shared/observation.mjs';
import { reloginLinkedinInline } from '../../../_shared/linkedin/relogin.mjs';
import { detectLinkedInBanSignals } from '../../../../../dist/platforms/linkedin/ban_signals.js';

// The origin and the dwell budget are declaration content: admission resolved
// linkedin.browse before this process existed. Nothing here names a URL.
const observed = declaredObservation();

await runAction({
  platform: 'linkedin', action: 'browse',
  inlineRelogin: reloginLinkedinInline,
  feedUrl: observed.origin, scrolls: observed.scrolls, dwellMs: observed.dwellMs,
  banDetector: detectLinkedInBanSignals,
});
