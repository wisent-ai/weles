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
  // Discord's auth is a localStorage token, not a cookie. If discord_login
  // persisted one into metadata.discord_token, inject it via an init script
  // so it's set before channels/@me loads and the SPA doesn't redirect to
  // /login.
  beforeGoto: async (s, acct) => {
    const token = acct.metadata?.discord_token;
    if (typeof token !== 'string' || !token) return;
    await s.ctx.addInitScript(`(() => { try { localStorage.setItem("token", ${JSON.stringify(JSON.stringify(token))}); } catch {} })()`);
  },
  extractLoggedIn: (body, resp) => {
    // Discord serves channels/@me as 200 HTML to unauthed users too, then JS
    // redirects to /login. The captured response URL stays at channels/@me
    // while the browser's final URL moves to /login. Use final_url from the
    // ban detector (it comes from page.url() post-navigation).
    const finalUrl = resp?.signal?.details?.final_url ?? resp?.url ?? '';
    const authed = /\/channels\/@me/.test(finalUrl) && !/\/login/.test(finalUrl);
    const html = typeof body === 'string' ? body : '';
    return {
      ok: authed && resp?.status === 200,
      karma: null,
      is_suspended: /account disabled|your account has been terminated/i.test(html),
    };
  },
});
