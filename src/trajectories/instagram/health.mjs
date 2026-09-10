import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';

// instagram.com/api/v1/* endpoints need an x-ig-app-id + x-csrftoken header
// set. Probe the root /feed — authed users stay on instagram.com, unauthed
// get redirected to /accounts/login/.
await runHealthProbe({
  platform: 'instagram',
  loggedInUrl: 'https://www.instagram.com/',
  loggedInRegex: /instagram\.com\/($|\?|accounts\/login)/,
  loggedOutUrl: (u) => `https://www.instagram.com/${encodeURIComponent(u)}/`,
  loggedOutRegex: /instagram\.com\/[^/?]+\/$/,
  banDetector: detectInstagramBanSignals,
  extractLoggedIn: (body, resp) => {
    const finalUrl = resp?.url ?? '';
    const authed = !/\/accounts\/login/.test(finalUrl) && /instagram\.com/.test(finalUrl);
    const html = typeof body === 'string' ? body : '';
    return {
      ok: authed && resp?.status === 200,
      karma: null,
      is_suspended: /your account has been disabled|account has been suspended/i.test(html),
    };
  },
  extractLoggedOut: (resp) => resp.status === 200 && !/sorry, this page isn'?t available|page not found/i.test(typeof resp.body === 'string' ? resp.body : ''),
});
