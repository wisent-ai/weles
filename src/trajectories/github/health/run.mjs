// GitHub health probe — lives in github/health/run.mjs because the github/
// top folder already has 5 files at its sibling level (solvers + register).
// Invoke via: node src/trajectories/github/health/run.mjs
import { runHealthProbe } from '../../_shared/health-runner.mjs';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';

// api.github.com rejects web session cookies — it wants a personal-access-token
// Bearer header our accounts don't have. Probe github.com itself instead: the
// /settings/profile page renders only for authed users (unauthed gets redirected
// to /login), and the logged-out /<username> profile URL returns 200 (exists)
// or 404 (doesn't/shadowbanned).
await runHealthProbe({
  platform: 'github',
  loggedInUrl: 'https://github.com/settings/profile',
  loggedInRegex: /github\.com\/(settings\/profile|login)/,
  loggedOutUrl: (u) => `https://github.com/${encodeURIComponent(u)}`,
  loggedOutRegex: /github\.com\/[^/?]+$/,
  banDetector: detectGitHubBanSignals,
  extractLoggedIn: (body, resp) => {
    // The captured body is a 2000-char HTML prefix, which is just the <head>
    // on github.com — user-visible content like "Public profile" appears well
    // past that. Instead rely on the final URL + HTTP status: unauthed gets
    // a 302 to /login, authed renders /settings/profile with status 200.
    const finalUrl = resp?.url ?? '';
    const authed = /\/settings\/profile/.test(finalUrl) && !/\/login/.test(finalUrl) && resp?.status === 200;
    const html = typeof body === 'string' ? body : '';
    return {
      ok: authed,
      karma: null,
      is_suspended: /account (has been )?suspended|flagged for review/i.test(html),
    };
  },
  extractLoggedOut: (resp) => resp.status === 200 && typeof resp.body === 'string' && !/this is not the web page you are looking for/i.test(resp.body),
});
