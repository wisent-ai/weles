/**
 * Reddit ban/shadowban/rate-limit signal detector.
 *
 * Called at the end of every reddit trajectory to classify the session's
 * final state into a named signal. Writes structured JSON that the worker
 * pool PATCHes into account_action_logs.result.ban_signal so a banned
 * account surfaces as a typed event, not a free-text failure string.
 */
import type { Page } from 'playwright';

export interface BanSignal {
  healthy: boolean;
  signal: 'healthy' | 'suspended' | 'rate_limited' | 'captcha_challenge' | 'checkpoint' | 'shadowban_suspected' | 'unknown_error';
  details: Record<string, unknown>;
}

// URL patterns that almost always indicate the account (or request) is blocked.
const SUSPENDED_URL_PATTERNS = [/\/suspended/i, /\/banned/i, /\/account-activity/i, /\/blocked/i];
const CHECKPOINT_URL_PATTERNS = [/\/verification/i, /verify[-_]?email/i, /checkpoint/i];

const SUSPENDED_TEXT_PATTERNS = [
  /your account has been suspended/i,
  /account is suspended/i,
  /this account has been permanently suspended/i,
  /this account has been banned/i,
];
const RATE_LIMIT_TEXT_PATTERNS = [
  /you're doing that too much/i,
  /try again in a few (minutes|seconds)/i,
  /looks like you'?re using a bot/i,
];
const CHECKPOINT_TEXT_PATTERNS = [
  /verify your email/i,
  /please verify your account/i,
  /confirm your email/i,
];

export async function detectRedditBanSignals(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }> = [],
): Promise<BanSignal> {
  const details: Record<string, unknown> = {};
  const url = page.url();
  details.final_url = url;

  for (const pat of SUSPENDED_URL_PATTERNS) {
    if (pat.test(url)) return { healthy: false, signal: 'suspended', details: { ...details, matched_url: pat.source } };
  }
  for (const pat of CHECKPOINT_URL_PATTERNS) {
    if (pat.test(url)) return { healthy: false, signal: 'checkpoint', details: { ...details, matched_url: pat.source } };
  }

  // DOM-text scan — visible text only, not raw HTML, to avoid false positives
  // from links like `<a href="/help/suspended">` elsewhere on the page.
  let bodyText = '';
  try {
    bodyText = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')) || '';
  } catch { /* noop */ }
  details.body_text_sample = bodyText.slice(0, 240);

  for (const pat of SUSPENDED_TEXT_PATTERNS) {
    if (pat.test(bodyText)) return { healthy: false, signal: 'suspended', details: { ...details, matched_text: pat.source } };
  }
  for (const pat of CHECKPOINT_TEXT_PATTERNS) {
    if (pat.test(bodyText)) return { healthy: false, signal: 'checkpoint', details: { ...details, matched_text: pat.source } };
  }
  for (const pat of RATE_LIMIT_TEXT_PATTERNS) {
    if (pat.test(bodyText)) return { healthy: false, signal: 'rate_limited', details: { ...details, matched_text: pat.source } };
  }

  const hasCaptchaFrame = page.frames().some((f) => /recaptcha|hcaptcha|arkoselabs|funcaptcha/i.test(f.url()));
  if (hasCaptchaFrame) {
    return { healthy: false, signal: 'captcha_challenge', details: { ...details, captcha_iframe_present: true } };
  }

  for (const r of responses) {
    if (r.status === 429) {
      return { healthy: false, signal: 'rate_limited', details: { ...details, rate_limited_url: r.url, retry_after: r.headers?.['retry-after'] } };
    }
    if (!r.body) continue;
    if (/"is_suspended"\s*:\s*true/.test(r.body)) {
      return { healthy: false, signal: 'suspended', details: { ...details, api_is_suspended: true, flagged_url: r.url } };
    }
    if (/SUBREDDIT_RATELIMIT|RATELIMIT|QUOTA_FILLED|THREAD_LOCKED/.test(r.body) && /\/api\/(vote|comment|submit)/.test(r.url)) {
      return { healthy: false, signal: 'rate_limited', details: { ...details, api_error: true, flagged_url: r.url } };
    }
    if (/USER_REQUIRED|AUTHENTICATION_REQUIRED|LOGIN_REQUIRED/.test(r.body) && /\/api\//.test(r.url)) {
      return { healthy: false, signal: 'checkpoint', details: { ...details, api_requires_reauth: true, flagged_url: r.url } };
    }
  }

  const suspiciousNon2xx = responses.find((r) => (r.status >= 400) && /\/api\/(vote|comment|submit|me|login)/.test(r.url));
  if (suspiciousNon2xx) {
    return {
      healthy: false,
      signal: 'unknown_error',
      details: { ...details, suspicious_url: suspiciousNon2xx.url, status: suspiciousNon2xx.status },
    };
  }

  return { healthy: true, signal: 'healthy', details };
}
