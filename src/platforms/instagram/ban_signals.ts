import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectInstagramBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      // /accounts/login means cookies didn't take — action trajectories that
      // land here interact with a logged-out shell and fail downstream while
      // the detector has no platform-ban keyword to match. Mark as checkpoint.
      checkpoint: [/\/challenge\//, /\/auth_platform\//, /\/accounts\/disabled/, /\/accounts\/login/, /\/accounts\/onetap/, /\/accounts\/emailsignup/],
      suspended: [/\/accounts\/suspended/, /\/error\/help/],
    },
    text: {
      suspended: [/your account has been disabled/i, /we suspended your account/i],
      // /try again later/i removed — too generic, fires on every instagram
      // server error. Keep only the specific rate-limit phrases.
      rate_limited: [/please wait a few minutes before you try again/i, /action blocked/i, /we limit how often/i],
      // 'Log into Instagram' + 'Mobile number, username or email' is the
      // logged-out modal IG renders on instagram.com root when cookies
      // expire. The URL stays on the root (no /accounts/login redirect)
      // so the URL-pattern check above misses it; match body text instead.
      checkpoint: [/we restrict certain content and actions/i, /confirm.{0,10}it'?s you/i, /enter the (code|confirmation)/i, /log into instagram/i, /mobile number, username or email/i, /see everyday moments from your close friends/i],
    },
    responseBody: [
      { signal: 'checkpoint', urlMatch: /\/api\/v1\//, bodyMatch: /"checkpoint_required":\s*true|feedback_required/i },
      // Drop /please wait/i from the response-body match — Instagram's
      // login page at /ajax/bulk-route-definitions/ returned that text
      // in an unrelated loading-state message, triggering false positives
      // across 56 dwell/browse/search rows in the 7-day window.
      { signal: 'rate_limited', urlMatch: /\/api\//, bodyMatch: /rate.?limit|we limit how often/i },
      { signal: 'suspended', urlMatch: /\/api\//, bodyMatch: /"is_disabled":\s*true|account.{0,10}disabled/i },
    ],
    suspiciousApiEndpoints: /\/api\/v1\/(media|friendships|users|web)/,
  });
}
