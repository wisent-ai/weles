import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectTwitterBanSignals } from '../../../dist/platforms/twitter/ban_signals.js';

// twitter.com's v1.1 API endpoints need an x-csrf-token header a plain
// navigation doesn't send. Probe x.com/home instead — authed users stay there,
// unauthed get redirected to /i/flow/login. Runner injects stored cookies so
// accounts with auth_token captured authenticate.
await runHealthProbe({
  platform: 'twitter',
  loggedInUrl: 'https://x.com/home',
  loggedInRegex: /x\.com\/(home|i\/flow\/login)/,
  loggedOutUrl: (u) => `https://x.com/${encodeURIComponent(u)}`,
  loggedOutRegex: /x\.com\/[^/?]+$/,
  banDetector: detectTwitterBanSignals,
  extractLoggedIn: (body, resp) => {
    const finalUrl = resp?.url ?? '';
    const authed = /x\.com\/home/.test(finalUrl) && !/\/i\/flow\/login/.test(finalUrl);
    const html = typeof body === 'string' ? body : '';
    return {
      ok: authed && resp?.status === 200,
      karma: null,
      is_suspended: /your account is suspended|account has been suspended/i.test(html),
    };
  },
  extractLoggedOut: (resp) => resp.status === 200 && !/account suspended|page doesn'?t exist/i.test(typeof resp.body === 'string' ? resp.body : ''),
});
