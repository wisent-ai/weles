import { runAction } from '../../_shared/action-runner.mjs';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';

await runAction({
  platform: 'github', action: 'browse',
  feedUrl: 'https://github.com/trending', scrolls: 5,
  banDetector: detectGitHubBanSignals,
});
