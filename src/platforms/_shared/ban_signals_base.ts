/**
 * Shared base for per-platform ban-signal detectors.
 *
 * Each platform supplies a config of regex sets keyed by signal name.
 * The engine runs them in priority order (URL → DOM text → response bodies →
 * captcha iframe) and returns the first match. Same BanSignal shape as the
 * Reddit-specific detector at src/platforms/reddit/ban_signals.ts so callers
 * (worker pool, action_log writer) handle every platform identically.
 */
import type { Page } from 'playwright';

export type BanSignalKind =
  | 'healthy' | 'suspended' | 'rate_limited' | 'captcha_challenge'
  | 'checkpoint' | 'shadowban_suspected' | 'unknown_error';

export interface BanSignal {
  healthy: boolean;
  signal: BanSignalKind;
  details: Record<string, unknown>;
}

export interface DetectorConfig {
  url?: Partial<Record<BanSignalKind, RegExp[]>>;
  text?: Partial<Record<BanSignalKind, RegExp[]>>;
  /** Response-body match: signal + url-filter + body-pattern (all must match). */
  responseBody?: Array<{ signal: BanSignalKind; urlMatch: RegExp; bodyMatch: RegExp; details?: Record<string, unknown> }>;
  /** Iframe URLs that indicate a captcha challenge. Default covers reCAPTCHA/hCaptcha/Arkose. */
  captchaFrameMatch?: RegExp;
  /** API endpoints whose 4xx/5xx is suspicious enough to flag unknown_error. */
  suspiciousApiEndpoints?: RegExp;
}

const DEFAULT_CAPTCHA = /recaptcha|hcaptcha|arkoselabs|funcaptcha|geetest/i;

export async function detectFromConfig(
  page: Page,
  responses: Array<{ url: string; status: number; headers?: Record<string, string>; body?: string }>,
  cfg: DetectorConfig,
): Promise<BanSignal> {
  const details: Record<string, unknown> = {};
  const url = page.url();
  details.final_url = url;

  // 1. URL patterns
  for (const [sig, patterns] of Object.entries(cfg.url ?? {})) {
    for (const pat of patterns ?? []) {
      if (pat.test(url)) return { healthy: false, signal: sig as BanSignalKind, details: { ...details, matched_url: pat.source } };
    }
  }

  // 2. DOM text
  let bodyText = '';
  try { bodyText = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')) || ''; } catch { /* noop */ }
  details.body_text_sample = bodyText.slice(0, 240);
  for (const [sig, patterns] of Object.entries(cfg.text ?? {})) {
    for (const pat of patterns ?? []) {
      if (pat.test(bodyText)) return { healthy: false, signal: sig as BanSignalKind, details: { ...details, matched_text: pat.source } };
    }
  }

  // 3. Captcha iframe
  const captchaRx = cfg.captchaFrameMatch ?? DEFAULT_CAPTCHA;
  if (page.frames().some((f) => captchaRx.test(f.url()))) {
    return { healthy: false, signal: 'captcha_challenge', details: { ...details, captcha_iframe_present: true } };
  }

  // 4. Response bodies + 429 detection
  for (const r of responses) {
    if (r.status === 429) {
      return { healthy: false, signal: 'rate_limited', details: { ...details, rate_limited_url: r.url, retry_after: r.headers?.['retry-after'] } };
    }
    if (!r.body) continue;
    for (const rule of cfg.responseBody ?? []) {
      if (rule.urlMatch.test(r.url) && rule.bodyMatch.test(r.body)) {
        return { healthy: false, signal: rule.signal, details: { ...details, ...(rule.details ?? {}), matched_url: r.url } };
      }
    }
  }

  // 5. Suspicious-but-unclassified API failure
  if (cfg.suspiciousApiEndpoints) {
    const sus = responses.find((r) => r.status >= 400 && cfg.suspiciousApiEndpoints!.test(r.url));
    if (sus) return { healthy: false, signal: 'unknown_error', details: { ...details, suspicious_url: sus.url, status: sus.status } };
  }

  return { healthy: true, signal: 'healthy', details };
}
