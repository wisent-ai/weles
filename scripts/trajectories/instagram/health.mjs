import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';

await runHealthProbe({
  platform: 'instagram',
  loggedInUrl: 'https://www.instagram.com/api/v1/accounts/current_user/',
  loggedInRegex: /\/api\/v1\/accounts\/current_user\//,
  loggedOutUrl: (u) => `https://www.instagram.com/${encodeURIComponent(u)}/?__a=1&__d=dis`,
  loggedOutRegex: /instagram\.com\/[^/]+\/\?__a=1/,
  banDetector: detectInstagramBanSignals,
  extractLoggedIn: (body) => ({
    ok: !!body?.user?.pk || !!body?.pk,
    karma: body?.user?.follower_count ?? body?.follower_count ?? null,
    is_suspended: !!(body?.is_disabled || body?.user?.is_disabled),
  }),
  extractLoggedOut: (resp) => resp.status === 200 && !!resp.body,
});
