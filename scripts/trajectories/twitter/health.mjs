import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectTwitterBanSignals } from '../../../dist/platforms/twitter/ban_signals.js';

await runHealthProbe({
  platform: 'twitter',
  loggedInUrl: 'https://twitter.com/i/api/1.1/account/settings.json',
  loggedInRegex: /\/account\/settings\.json/,
  loggedOutUrl: (u) => `https://x.com/${encodeURIComponent(u)}`,
  loggedOutRegex: /x\.com\/[^/?]+$/,
  banDetector: detectTwitterBanSignals,
  extractLoggedIn: (body) => ({
    ok: !!body && !!(body.screen_name || body.id_str),
    karma: body?.followers_count ?? null,
    is_suspended: !!(body?.suspended || body?.status === 'suspended'),
  }),
  extractLoggedOut: (resp) => resp.status === 200 && !/account suspended|page doesn'?t exist/i.test(typeof resp.body === 'string' ? resp.body : ''),
});
