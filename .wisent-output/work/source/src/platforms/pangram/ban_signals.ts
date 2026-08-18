import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectPangramBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      checkpoint: [/\/(login|signin|sign-in|auth|session|sso)(\?|$|\/)/i],
      suspended: [/\/(suspended|disabled|banned)(\?|$|\/)/i],
    },
    text: {
      checkpoint: [
        /sign in to continue/i,
        /log in to continue/i,
        /session expired/i,
        /verify your email/i,
        /two[-\s]?factor/i,
      ],
      suspended: [/account has been suspended/i, /account is suspended/i, /account has been disabled/i],
      rate_limited: [/too many requests/i, /rate limit/i],
      insufficient_credits: [/out of free scans/i, /insufficient credits/i, /upgrade to get/i, /available\s+0\s*\/\s*\d+/i],
    },
    responseBody: [
      { signal: 'insufficient_credits', urlMatch: /\/api\//, bodyMatch: /out.?of.?free.?scans|insufficient.?credits|payment.?required|upgrade.?to.?get/i },
      { signal: 'rate_limited', urlMatch: /\/api\//, bodyMatch: /rate.?limit|too.?many.?requests/i },
      { signal: 'checkpoint', urlMatch: /\/api\//, bodyMatch: /unauthorized|session.?expired|login.?required/i },
    ],
    captchaFrameMatch: /recaptcha|hcaptcha|turnstile|cloudflare.*challenge/i,
    suspiciousApiEndpoints: /\/api\//,
  });
}
