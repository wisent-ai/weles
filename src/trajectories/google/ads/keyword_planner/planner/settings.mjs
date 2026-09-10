// The environment the keyword planner runs with, and the value readers it is parsed through.
import { runOutputPath } from '#run-output';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { closeAllowedByEnv } from '../../_profile_guard.mjs';
import { readScopedLogin } from '../../../../../_shared/scoped-secrets.mjs';

export const GOOGLE_ADS_LOGIN = readScopedLogin('googleAds');
export const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60 * 1000);
export const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
export const DIAG_DIR = process.env.GOOGLE_ADS_DIAG_DIR || runOutputPath('google-ads-keyword-planner');
export const RESULT_FILE = process.env.GOOGLE_ADS_RESULT_FILE || join(DIAG_DIR, 'keyword-planner.json');
export const CLOSE_AFTER_HARVEST = closeAllowedByEnv('GOOGLE_ADS_CLOSE_AFTER_HARVEST');
export const cid = normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID || '');
export const keywords = parseKeywords(process.env.GOOGLE_ADS_KEYWORDS || process.env.KEYWORDS || process.env.KEYWORD || '');
if (!cid) throw new Error('GOOGLE_ADS_CUSTOMER_ID required');
if (!keywords.length) throw new Error('GOOGLE_ADS_KEYWORDS required');

mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(DIAG_DIR, { recursive: true });

process.env.WELES_CAPTURE_RESPONSE_BODIES ??= '1';
process.env.WELES_DISABLE_RECORDING ??= '1';
process.env.WELES_NO_INSTRUMENT ??= '1';
process.env.WELES_VIEWPORT ??= '1440x1000';
process.env.GOOGLE_SSO_NO_SCREENSHOTS ??= '1';

export function parseKeywords(value) {
  return [...new Set(String(value || '')
    .split(/[\n,]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean))];
}

export function normalizeCustomerId(value) {
  return String(value || '').replace(/\D/g, '');
}

export function dashedCustomerId(value) {
  const id = normalizeCustomerId(value);
  if (id.length !== 10) return id;
  return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`;
}

export function norm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
