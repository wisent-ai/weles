import { runAction } from '../_shared/action-runner.mjs';
import { declaredObservation } from '../_shared/observation.mjs';
import { detectDiscordBanSignals } from '../../../dist/platforms/discord/ban_signals.js';

// The origin and the dwell budget are declaration content: admission resolved
// discord.browse before this process existed. Nothing here names a URL.
const observed = declaredObservation();

await runAction({
  platform: 'discord', action: 'browse',
  feedUrl: observed.origin, scrolls: observed.scrolls, dwellMs: observed.dwellMs,
  banDetector: detectDiscordBanSignals,
});
