// The environment the Google TOTP activation runs with, and the value helpers it shares.
import { runOutputPath } from '#run-output';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../../../../dist/browser/persona.js';
import { readScopedLogin } from '../../../../../_shared/scoped-secrets.mjs';

export const GOOGLE_ADS_LOGIN = readScopedLogin('googleAds');
export const EMAIL = GOOGLE_ADS_LOGIN.email;
export const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
export const DIAG_DIR = process.env.GOOGLE_TOTP_ACTIVATION_DIAG_DIR || runOutputPath('google-totp-activation');
export const RESULT_FILE = process.env.GOOGLE_TOTP_ACTIVATION_RESULT_FILE || join(DIAG_DIR, 'result.json');
export const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60_000);

process.env.WELES_VIEWPORT ??= '1440x1000';
process.env.WELES_DISABLE_RECORDING ??= '1';
process.env.WELES_NO_INSTRUMENT ??= '1';
process.env.GOOGLE_SSO_NO_SCREENSHOTS ??= '1';
mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(DIAG_DIR, { recursive: true });


export function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

export function extractTotpSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^otpauth:\/\//i.test(text)) {
    try { return new URL(text).searchParams.get('secret') || ''; } catch { return ''; }
  }
  return text;
}

export function normalizeSecret(secret) {
  return extractTotpSecret(secret).toUpperCase().replace(/[\s=-]/g, '');
}

export function redact(value, secret = '') {
  const normalized = normalizeSecret(secret);
  const escaped = normalized ? normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  let text = String(value || '');
  if (escaped) text = text.replace(new RegExp(escaped, 'gi'), '<redacted-totp-secret>');
  text = text
    .replace(/[A-Z2-7](?:\s?[A-Z2-7]){15,}/g, '<redacted-base32-secret>')
    .replace(/"login_password"\s*:\s*"[^"]+"/g, '"login_password":"<redacted>"')
    .replace(/"google_totp_secret"\s*:\s*"[^"]+"/g, '"google_totp_secret":"<redacted>"');
  return text;
}

export function visibleTextSelector() {
  return 'button, [role="button"], a, [role="link"], li, div[role="option"]';
}
