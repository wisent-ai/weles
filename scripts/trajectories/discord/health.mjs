import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectDiscordBanSignals } from '../../../dist/platforms/discord/ban_signals.js';

// Discord doesn't expose public profile pages to logged-out users, so
// loggedOutUrl is undefined — runner skips the second session and only checks
// session liveness + disabled flag via /users/@me.
await runHealthProbe({
  platform: 'discord',
  loggedInUrl: 'https://discord.com/api/v9/users/@me',
  loggedInRegex: /\/api\/v9\/users\/@me$/,
  banDetector: detectDiscordBanSignals,
  extractLoggedIn: (body) => ({
    ok: !!body?.id,
    karma: null,   // Discord has no public karma/follower metric
    is_suspended: !!body?.disabled,
  }),
});
