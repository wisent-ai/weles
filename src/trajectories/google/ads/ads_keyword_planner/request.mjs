// The run request: what the environment asked for, and where this run keeps
// its profile, its diagnostics and its result.
//
// Moved verbatim out of the single keyword-planner file during a split by
// responsibility.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../../../dist/browser/persona.js';
import { closeAllowedByEnv } from '../_profile_guard.mjs';
import { readScopedLogin } from '../../../../_shared/scoped-secrets.mjs';

export const GOOGLE_ADS_LOGIN = readScopedLogin('googleAds');
export const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60 * 1000);
export const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
export const DIAG_DIR = process.env.GOOGLE_ADS_DIAG_DIR || '.work/google-ads-keyword-planner';
export const RESULT_FILE = process.env.GOOGLE_ADS_RESULT_FILE || join(DIAG_DIR, 'keyword-planner.json');
export const CLOSE_AFTER_HARVEST = closeAllowedByEnv('GOOGLE_ADS_CLOSE_AFTER_HARVEST');

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

export const cid = normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID || '');
export const keywords = parseKeywords(process.env.GOOGLE_ADS_KEYWORDS || process.env.KEYWORDS || process.env.KEYWORD || '');

export function preferredGoogleAdsEmail() {
  return GOOGLE_ADS_LOGIN.email;
}

export function prepareRunDirectories() {
  mkdirSync(USER_DATA_DIR, { recursive: true });
  mkdirSync(DIAG_DIR, { recursive: true });
}

export function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

export async function resolveSsoCreds() {
  return { ...GOOGLE_ADS_LOGIN, source: 'skarbiec' };
}

export function campaignsUrl(paramName, target, authuser = preferredGoogleAdsEmail()) {
  const url = new URL('https://ads.google.com/aw/campaigns');
  url.searchParams.set(paramName, normalizeCustomerId(target));
  if (authuser) url.searchParams.set('authuser', authuser);
  return url.toString();
}

export function buildGoogleAdsPath(current, pathname) {
  const source = new URL(current || campaignsUrl('cid', cid));
  const target = new URL(pathname, 'https://ads.google.com');
  for (const key of ['ocid', 'authuser', '__u', '__c', 'uscid', 'euid', 'cid', '__e']) {
    const value = source.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  target.searchParams.set('authuser', preferredGoogleAdsEmail());
  if (!target.searchParams.get('cid')) target.searchParams.set('cid', cid);
  return target.toString();
}
