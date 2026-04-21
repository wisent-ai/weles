import type { Page } from 'playwright';
import { detectFromConfig, type BanSignal } from '../_shared/ban_signals_base.js';

export async function detectInstagramBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  return detectFromConfig(page, responses, {
    url: {
      checkpoint: [/\/challenge\//, /\/auth_platform\//, /\/accounts\/disabled/],
      suspended: [/\/accounts\/suspended/, /\/error\/help/],
    },
    text: {
      suspended: [/your account has been disabled/i, /we suspended your account/i],
      rate_limited: [/please wait a few minutes before you try again/i, /try again later/i, /action blocked/i],
      checkpoint: [/we restrict certain content and actions/i, /confirm.{0,10}it'?s you/i, /enter the (code|confirmation)/i],
    },
    responseBody: [
      { signal: 'checkpoint', urlMatch: /\/api\/v1\//, bodyMatch: /"checkpoint_required":\s*true|feedback_required/i },
      { signal: 'rate_limited', urlMatch: /\/api\//, bodyMatch: /rate.?limit|please wait/i },
      { signal: 'suspended', urlMatch: /\/api\//, bodyMatch: /"is_disabled":\s*true|account.{0,10}disabled/i },
    ],
    suspiciousApiEndpoints: /\/api\/v1\/(media|friendships|users|web)/,
  });
}
