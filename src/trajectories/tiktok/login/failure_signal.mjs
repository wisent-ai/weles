import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

/**
 * Classify a failed login from its error and the page it ended on. TikTok
 * login fails commonly at chrome-error proxy CONNECT, at the captcha widget
 * (SadCaptcha-gated), or with the rate-limit error code on register_verify_login.
 */
export function classifyLoginFailure(message, finalUrl) {
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(message)) return 'ip_blocked';
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(message)) return 'proxy_failed';
  if (finalUrl.startsWith('chrome-error://')) return 'proxy_failed';
  if (/login_rate_limited|Maximum number of attempts reached/i.test(message)) return 'rate_limited';
  if (/captcha|verify-app|app-download/i.test(message) || /\/login\/download-app|\/captcha/.test(finalUrl)) return 'captcha_challenge';
  if (/\/login/.test(finalUrl)) return 'checkpoint';
  return 'action_failed';
}

/**
 * Persist the login diagnostics and a structured ban_signal so the worker
 * reads the classified reason instead of 'unknown_error'.
 */
export function recordLoginFailure(error, s, acct, loginDiag) {
  const dir = runRecordingsDir('tiktok_login');
  mkdirSync(dir, { recursive: true });
  const finalUrl = s?.page?.url?.() ?? '';
  const message = error.message ?? '';
  const ts = new Date().toISOString();
  writeFileSync(join(dir, 'login_diag.json'), JSON.stringify({ ...loginDiag, error: message.slice(0, 200), final_url: finalUrl, ts }, null, 2));
  const signal = classifyLoginFailure(message, finalUrl);
  writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({
    account_id: acct.id,
    username: acct.username,
    action: 'tiktok_login',
    signal,
    healthy: false,
    details: { final_url: finalUrl, reason: error.message?.slice(0, 200) ?? 'no message' },
    ts,
  }, null, 2));
}
