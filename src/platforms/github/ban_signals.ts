import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectGitHubBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      checkpoint: [/\/sessions\/two-factor/, /\/sessions\/verified-device/, /\/account_verifications/],
      suspended: [/\/flagged/],
    },
    text: {
      suspended: [/this account has been flagged/i, /this account is suspended/i],
      rate_limited: [/abuse.{0,10}rate.{0,10}limit/i, /secondary rate limit/i],
      checkpoint: [/verification required/i, /verify your device/i, /unable to authenticate/i],
    },
    responseBody: [
      { signal: 'rate_limited', urlMatch: /\/api\//, bodyMatch: /abuse_rate_limit|secondary_rate_limit/i },
      { signal: 'checkpoint', urlMatch: /\/sessions\//, bodyMatch: /verification.{0,15}required/i },
    ],
    captchaFrameMatch: /arkoselabs|octocaptcha|funcaptcha|recaptcha|hcaptcha/i,
    suspiciousApiEndpoints: /\/api\/(v3\/|graphql)/,
  });
}
