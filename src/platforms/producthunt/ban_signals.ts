import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectProductHuntBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      checkpoint: [/\/users\/sign_in/, /\/verify/],
      suspended: [/\/suspended/, /\/banned/],
    },
    text: {
      suspended: [/account has been suspended/i, /account is banned/i],
      rate_limited: [/too many requests/i, /rate limit/i],
      checkpoint: [/please verify/i, /sign in to continue/i],
    },
    responseBody: [
      { signal: 'rate_limited', urlMatch: /\/api\//, bodyMatch: /rate_limit|too_many_requests/i },
    ],
    captchaFrameMatch: /recaptcha|hcaptcha|cloudflare.*challenge/i,
    suspiciousApiEndpoints: /\/api\//,
  });
}
