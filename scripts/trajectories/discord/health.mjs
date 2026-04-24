import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectDiscordBanSignals } from '../../../dist/platforms/discord/ban_signals.js';

// Discord's /api/v9/users/@me needs an Authorization header (the token, which
// lives in localStorage, not cookies). Probe the UI instead:
// discord.com/channels/@me — authed users see their DM list, unauthed get
// redirected to /login. Discord doesn't expose public profile pages so the
// logged-out shadowban check is skipped (loggedOutUrl undefined).
await runHealthProbe({
  platform: 'discord',
  loggedInUrl: 'https://discord.com/channels/@me',
  loggedInRegex: /discord\.com\/(channels\/@me|login)/,
  banDetector: detectDiscordBanSignals,
  extractLoggedIn: (body, resp) => {
    const finalUrl = resp?.url ?? '';
    const authed = /\/channels\/@me/.test(finalUrl) && !/\/login/.test(finalUrl);
    const html = typeof body === 'string' ? body : '';
    return {
      ok: authed && resp?.status === 200,
      karma: null,
      is_suspended: /account disabled|your account has been terminated/i.test(html),
    };
  },
});
