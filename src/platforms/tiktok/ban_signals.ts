import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectTikTokBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      suspended: [/\/account\/penalty/, /\/banned/, /\/account\/login\?error/],
      checkpoint: [/\/captcha-verify/, /\/login\/redirect/],
    },
    text: {
      suspended: [/account banned/i, /your account has been (permanently )?suspended/i],
      // /try again later/i removed — it matched TikTok's generic "Sorry
      // about that! Please try again later" error page which fires for
      // every server hiccup, not rate-limiting. Keep only the specific
      // rate-limit phrases the actual throttle page shows.
      rate_limited: [/maximum number of attempts reached/i, /you can'?t perform this action/i, /you'?re doing that too much/i],
      checkpoint: [/login expired/i, /verify your account/i, /complete the verification/i],
    },
    responseBody: [
      // TikTok's signature error_code:7 from /register_verify_login/
      { signal: 'rate_limited', urlMatch: /\/passport\/web\/email\/register_verify_login\//, bodyMatch: /"error_code":\s*7/ },
      { signal: 'suspended', urlMatch: /\/aweme\/v1\/|\/passport\//, bodyMatch: /"status_code":\s*200(0|3|6|9)\b/ },
      { signal: 'rate_limited', urlMatch: /\/aweme\/v1\//, bodyMatch: /rate.?limit|too frequent/i },
    ],
    suspiciousApiEndpoints: /\/aweme\/v1\/(commit|create|post|favorite|follow)/,
  });
}
