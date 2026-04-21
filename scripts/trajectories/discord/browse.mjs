import { runAction } from '../_shared/action-runner.mjs';
import { detectDiscordBanSignals } from '../../../dist/platforms/discord/ban_signals.js';

await runAction({
  platform: 'discord', action: 'browse',
  feedUrl: 'https://discord.com/channels/@me', scrolls: 4,
  banDetector: detectDiscordBanSignals,
});
