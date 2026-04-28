import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectTwitterBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      suspended: [/\/account\/access/, /\/suspended/, /\/i\/flow\/account_compromised/],
      // Any /i/flow/login* (including bare /i/flow/login when the agent
      // stalls on 2FA / arkose, or session_redirect bounce-back) is a
      // logged-out wall — mark as checkpoint so action trajectories that
      // land here are categorized as cookies-stale, not healthy.
      checkpoint: [/\/i\/flow\/login_challenge/, /\/i\/flow\/login(\?|$|\/)/, /\/i\/flow\/verify/, /\/account\/verify/, /\/login(\?|$|\/)/, /\/i\/flow\/signup/],
    },
    text: {
      suspended: [/your account is suspended/i, /this account doesn'?t exist/i],
      rate_limited: [/sorry,? you are rate limited/i, /you'?re temporarily restricted from performing this action/i, /you'?ve been rate limited/i],
      checkpoint: [/we sent you a code/i, /confirm your email address/i, /verify your phone/i],
    },
    responseBody: [
      { signal: 'suspended', urlMatch: /\/api\/(graphql|1\.1)/, bodyMatch: /"code":\s*32\b|"code":\s*64\b|account.{0,20}suspend/i },
      { signal: 'rate_limited', urlMatch: /\/api\//, bodyMatch: /rate.?limit|too many/i },
    ],
    suspiciousApiEndpoints: /\/api\/(graphql|1\.1)\/(favorites|statuses|friendships|users)/,
  });
}
