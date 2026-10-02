import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectLinkedInBanSignals } from '../../../dist/platforms/linkedin/ban_signals.js';

await runHealthProbe({
  platform: 'linkedin',
  loggedInUrl: 'https://www.linkedin.com/voyager/api/me',
  loggedInRegex: /\/voyager\/api\/me/,
  loggedOutUrl: (u) => `https://www.linkedin.com/in/${encodeURIComponent(u)}/`,
  loggedOutRegex: /linkedin\.com\/in\/[^/?]+/,
  banDetector: detectLinkedInBanSignals,
  extractLoggedIn: (body, resp) => {
    // Voyager API requires a csrf-token header that a plain page navigation
    // doesn't send, so we see 403 "CSRF check failed" on a cookie-authed but
    // header-incomplete request. That 403 still PROVES the session cookies
    // are valid — an unauthed request gets 401 / authwall redirect instead.
    const status = resp?.status;
    const textBody = typeof body === 'string' ? body : null;
    const csrfOnly = status === 403 && textBody && /csrf check failed/i.test(textBody);
    const ok = !!(body?.miniProfile?.entityUrn || body?.plainId || csrfOnly);
    return {
      ok,
      karma: body?.connectionsCount ?? null,
      is_suspended: !!(body?.restricted || body?.accountStatus === 'RESTRICTED'),
    };
  },
  // Non-member requests can return 999 for an existing profile. A registration
  // username can also differ from the canonical profile slug, so 404 alone
  // does not establish an account restriction.
  extractLoggedOut: (resp) => resp.status === 200 || resp.status === 999 || resp.status === 404,
});
