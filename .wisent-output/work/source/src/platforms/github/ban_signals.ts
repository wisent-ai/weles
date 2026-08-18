import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectGitHubBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      checkpoint: [/\/sessions\/two-factor/, /\/sessions\/verified-device/, /\/account_verifications/, /\/login(\?|$|\/)/, /\/login\/oauth\/authorize/],
      suspended: [/\/flagged/],
    },
    text: {
      suspended: [/this account has been flagged/i, /this account is suspended/i],
      rate_limited: [/abuse.{0,10}rate.{0,10}limit/i, /secondary rate limit/i],
      // checkpoint = cookies stale / login wall. GitHub serves the signed-out
      // discovery page ("Find code, projects, and people on GitHub") when the
      // session cookie is invalid; without this match the detector returned
      // healthy on logged-out pages and the trajectory's caller saw status=
      // failed + signal=healthy (a useless combination).
      checkpoint: [/verification required/i, /verify your device/i, /unable to authenticate/i, /sign in to github/i, /find code, projects, and people on github/i, /github is where over .{0,30} build software/i],
    },
    responseBody: [
      { signal: 'rate_limited', urlMatch: /\/api\//, bodyMatch: /abuse_rate_limit|secondary_rate_limit/i },
      { signal: 'checkpoint', urlMatch: /\/sessions\//, bodyMatch: /verification.{0,15}required/i },
    ],
    captchaFrameMatch: /arkoselabs|octocaptcha|funcaptcha|recaptcha|hcaptcha/i,
    suspiciousApiEndpoints: /\/api\/(v3\/|graphql)/,
  });
}
