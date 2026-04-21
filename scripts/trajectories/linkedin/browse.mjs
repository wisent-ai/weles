import { runAction } from '../_shared/action-runner.mjs';
import { detectLinkedInBanSignals } from '../../../dist/platforms/linkedin/ban_signals.js';

await runAction({
  platform: 'linkedin', action: 'browse',
  feedUrl: 'https://www.linkedin.com/feed/', scrolls: 8,
  banDetector: detectLinkedInBanSignals,
});
