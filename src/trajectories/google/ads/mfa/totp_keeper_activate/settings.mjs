// The environment the keeper-driven Google TOTP activation runs with, and its result writer.
import { runOutputPath } from '#run-output';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readScopedLogin } from '../../../../../_shared/scoped-secrets.mjs';

export const GOOGLE_ADS_LOGIN = readScopedLogin('googleAds');
export const REPO = process.env.WELES_REPO || resolve(process.cwd(), '..', 'weles');
export const SESSION = process.env.SESSION || process.env.GOOGLE_ADS_KEEPER_SESSION || 'google_ads';
export const EMAIL = GOOGLE_ADS_LOGIN.email;
export const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
export const KEEPER = join(REPO, 'src', 'keeper', 'keeper.mjs');
export const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
export const DIAG_DIR = process.env.GOOGLE_TOTP_KEEPER_DIAG_DIR || runOutputPath('google-totp-keeper');
export const RESULT_FILE = process.env.GOOGLE_TOTP_KEEPER_RESULT_FILE || join(DIAG_DIR, 'result.json');
export const AUTHENTICATOR_URL = 'https://myaccount.google.com/u/1/two-step-verification/authenticator';
export const SECURITY_URL = 'https://myaccount.google.com/u/1/security';

mkdirSync(DIAG_DIR, { recursive: true });

export function scopedChildEnvironment(overrides) {
  const env = { ...process.env, ...overrides };
  const exactAmbientKeys = [
    'GOOGLE_ADS_EMAIL',
    'GOOGLE_PASSWORD',
    'GOOGLE_TOTP_SECRET',
    'GOOGLE_AUTHENTICATOR_SECRET',
    'GOOGLE_SSO_MANUAL_TOTP_CODE',
    'GOOGLE_SSO_MANUAL_TOTP',
    'GOOGLE_SSO_MANUAL_TOTP_FILE',
    'GOOGLE_SSO_MANUAL_TOTP_READY_FILE',
    'GOOGLE_TOTP_CODE',
    'SSO_EMAIL',
    'SSO_PASS',
    'SSO_PASSWORD',
    'SSO_TOTP_SECRET',
    'GM_EMAIL',
    'GM_PASSWORD',
    'GM_TOTP_SECRET',
    'BRIGHTDATA_ZONE',
    'BRIGHTDATA_BROWSER_WS',
  ];
  for (const key of exactAmbientKeys) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^(?:OXYLABS|BRIGHTDATA)_(?:.*(?:USERNAME|PASSWORD|USER|PASS))$/.test(key)) delete env[key];
  }
  return env;
}

export function redact(text, secret = '') {
  const escaped = secret ? String(secret).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  let out = String(text || '');
  if (escaped) out = out.replace(new RegExp(escaped, 'gi'), '<redacted-totp-secret>');
  return out
    .replace(/[A-Z2-7](?:\s?[A-Z2-7]){15,}/g, '<redacted-base32-secret>')
    .replace(/"login_password"\s*:\s*"[^"]+"/g, '"login_password":"<redacted>"')
    .replace(/"google_totp_secret"\s*:\s*"[^"]+"/g, '"google_totp_secret":"<redacted>"');
}

export function writeResult(report, code = 0, secret = '') {
  const safe = JSON.parse(redact(JSON.stringify(report), secret));
  writeFileSync(RESULT_FILE, JSON.stringify(safe, null, 2));
  console.log(JSON.stringify(safe, null, 2));
  process.exit(code);
}

export function socketReady() {
  return existsSync(SOCK);
}
