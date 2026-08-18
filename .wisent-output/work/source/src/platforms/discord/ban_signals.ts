import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectDiscordBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      suspended: [/\/disabled/, /\/banned/],
      // /login (with or without redirect_to=...) means cookies didn't take —
      // any action trajectory landing here is operating in a logged-out
      // session and will fail downstream with the detector reporting healthy
      // because no platform-ban keyword appears on the login page.
      checkpoint: [/\/verify/, /\/captcha/, /discord\.com\/login(\?|$|\/)/, /discord\.com\/register(\?|$|\/)/],
    },
    text: {
      suspended: [/your account has been disabled/i, /this account is disabled/i],
      rate_limited: [/you are being rate limited/i, /too many requests/i],
      // The Discord login form's "Welcome back!" + "Email or Phone Number" is
      // the cookies-stale tell when the URL pattern doesn't catch it.
      checkpoint: [/please verify your account/i, /complete the captcha/i, /confirm.{0,10}email/i, /welcome back!.{0,40}we're so excited/i, /email or phone number/i],
    },
    responseBody: [
      { signal: 'captcha_challenge', urlMatch: /\/api\/v\d+\/auth\//, bodyMatch: /captcha_key|CAPTCHA_REQUIRED|CAPTCHA_INVALID/ },
      { signal: 'rate_limited', urlMatch: /\/api\/v\d+\//, bodyMatch: /"retry_after":\s*\d|rate.?limit/i },
      { signal: 'suspended', urlMatch: /\/api\/v\d+\//, bodyMatch: /ACCOUNT_DISABLED|account.{0,10}disabled/i },
    ],
    suspiciousApiEndpoints: /\/api\/v\d+\/(channels|guilds|users\/@me\/relationships)/,
  });
}
