import { runHealthProbe } from '../_shared/health-runner.mjs';
import { detectLinkedInBanSignals } from '../../../dist/platforms/linkedin/ban_signals.js';
import {
  HTTP_FORBIDDEN,
  HTTP_OK,
} from '../../worker/weles-api-server/routes/http-status.mjs';

await runHealthProbe({
  platform: 'linkedin',
  loggedInUrl: 'https://www.linkedin.com/voyager/api/me',
  loggedInRegex: /\/voyager\/api\/me/,
  loggedOutUrl: (u) => `https://www.linkedin.com/in/${encodeURIComponent(u)}/`,
  loggedOutRegex: /linkedin\.com\/in\/[^/?]+/,
  banDetector: detectLinkedInBanSignals,
  extractLoggedIn: (body, resp) => {
    // Voyager API requires a csrf-token header that a plain page navigation
    // doesn't send, so a cookie-authed but header-incomplete request is
    // answered 403 with Voyager's own CSRF refusal. That refusal still proves
    // the session cookies are valid: an unauthed request gets 401 or the
    // authwall redirect instead.
    const csrfOnly =
      resp.status === HTTP_FORBIDDEN &&
      typeof body === 'string' &&
      /csrf check failed/i.test(body);
    const profile = body && typeof body === 'object' ? body : {};
    return {
      ok: Boolean(
        profile.miniProfile?.entityUrn || profile.plainId || csrfOnly,
      ),
      karma:
        typeof profile.connectionsCount === 'number'
          ? profile.connectionsCount
          : null,
      is_suspended: Boolean(
        profile.restricted || profile.accountStatus === 'RESTRICTED',
      ),
    };
  },
  // Only a profile page LinkedIn served shows the profile is public. LinkedIn
  // answers non-members with its own refusal statuses for existing profiles,
  // and a registration username can differ from the canonical profile slug,
  // so any other answer cannot tell.
  extractLoggedOut: (resp) => (resp.status === HTTP_OK ? true : null),
});
