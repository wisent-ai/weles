import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectTikTokBanSignals } from '../../../dist/platforms/tiktok/ban_signals.js';

// Probe /foryou — authed accounts see the feed, unauthed get redirected or
// shown a login prompt. Runner injects stored cookies (sessionid, sid_guard).
await runHealthProbe({
  platform: 'tiktok',
  loggedInUrl: 'https://www.tiktok.com/foryou',
  loggedInRegex: /tiktok\.com\/(foryou|login)/,
  loggedOutUrl: (u) => `https://www.tiktok.com/@${encodeURIComponent(u)}`,
  loggedOutRegex: /tiktok\.com\/@[^/?]+$/,
  banDetector: detectTikTokBanSignals,
  extractLoggedIn: (body, resp) => {
    const finalUrl = resp?.url ?? '';
    const authed = /\/foryou/.test(finalUrl) && !/\/login/.test(finalUrl);
    const html = typeof body === 'string' ? body : '';
    return {
      ok: authed && resp?.status === 200,
      karma: null,
      is_suspended: /account has been banned|suspended|violates our community guidelines/i.test(html),
    };
  },
  extractLoggedOut: (resp) => resp.status === 200 && typeof resp.body === 'string' && !/banned|account doesn'?t exist|couldn'?t find this account/i.test(resp.body),
});
