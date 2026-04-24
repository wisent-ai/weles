import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectLinkedInBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      // /uas/login is the default unauthed redirect — it means the session
      // cookies expired, not that LinkedIn is challenging. Classifying it as
      // 'checkpoint' drowned the real ban signals in expired-cookie noise.
      // Real checkpoint URLs contain /checkpoint/ or /check/manage-account.
      checkpoint: [/\/checkpoint\//, /\/check\/manage-account/],
      suspended: [/\/help\/linkedin\/answer.*restrict/, /\/restrict/],
    },
    text: {
      suspended: [/your account has been restricted/i, /account.{0,10}restricted/i],
      rate_limited: [/temporarily restricted/i, /you'?ve reached the weekly invitation limit/i, /commercial use limit/i],
      checkpoint: [/let'?s do a quick security check/i, /verify your identity/i, /enter the (code|verification)/i],
    },
    responseBody: [
      { signal: 'checkpoint', urlMatch: /\/voyager\/api\//, bodyMatch: /CHALLENGE|SECURITY_CHECKPOINT/ },
      { signal: 'rate_limited', urlMatch: /\/voyager\/api\//, bodyMatch: /TOO_MANY_REQUESTS|throttled/i },
    ],
    suspiciousApiEndpoints: /\/voyager\/api\/(invitation|messaging|growth|relationships)/,
  });
}
