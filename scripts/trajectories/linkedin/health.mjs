import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectLinkedInBanSignals } from '../../../dist/platforms/linkedin/ban_signals.js';

await runHealthProbe({
  platform: 'linkedin',
  loggedInUrl: 'https://www.linkedin.com/voyager/api/me',
  loggedInRegex: /\/voyager\/api\/me/,
  loggedOutUrl: (u) => `https://www.linkedin.com/in/${encodeURIComponent(u)}/`,
  loggedOutRegex: /linkedin\.com\/in\/[^/?]+/,
  banDetector: detectLinkedInBanSignals,
  extractLoggedIn: (body) => ({
    ok: !!body?.miniProfile?.entityUrn || !!body?.plainId,
    karma: body?.connectionsCount ?? body?.plainId ? null : null,
    is_suspended: !!(body?.restricted || body?.accountStatus === 'RESTRICTED'),
  }),
  extractLoggedOut: (resp) => resp.status === 200 && typeof resp.body === 'string' && !/member doesn'?t exist|page not found/i.test(resp.body),
});
