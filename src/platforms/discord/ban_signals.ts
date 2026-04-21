import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectDiscordBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      suspended: [/\/disabled/, /\/banned/],
      checkpoint: [/\/verify/, /\/captcha/],
    },
    text: {
      suspended: [/your account has been disabled/i, /this account is disabled/i],
      rate_limited: [/you are being rate limited/i, /too many requests/i],
      checkpoint: [/please verify your account/i, /complete the captcha/i, /confirm.{0,10}email/i],
    },
    responseBody: [
      { signal: 'captcha_challenge', urlMatch: /\/api\/v\d+\/auth\//, bodyMatch: /captcha_key|CAPTCHA_REQUIRED|CAPTCHA_INVALID/ },
      { signal: 'rate_limited', urlMatch: /\/api\/v\d+\//, bodyMatch: /"retry_after":\s*\d|rate.?limit/i },
      { signal: 'suspended', urlMatch: /\/api\/v\d+\//, bodyMatch: /ACCOUNT_DISABLED|account.{0,10}disabled/i },
    ],
    suspiciousApiEndpoints: /\/api\/v\d+\/(channels|guilds|users\/@me\/relationships)/,
  });
}
