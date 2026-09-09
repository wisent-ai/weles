// What this run was asked for and how it answers. The Google Ads customer, the
// keywords to look up, the keeper session whose browser holds the login, the
// Skarbiec identity the run signs in with, and the single JSON record it writes
// before exiting with the code that says how far it got.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readScopedLogin } from '../../../../_shared/scoped-secrets.mjs';

const GOOGLE_ADS_LOGIN = readScopedLogin('googleAds');
export const SESSION = process.env.SESSION || process.env.GOOGLE_ADS_KEEPER_SESSION || 'google_ads';
export const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
export const DIAG_DIR = process.env.GOOGLE_ADS_DIAG_DIR || '.work/google-ads-keyword-planner';
export const RESULT_FILE = process.env.GOOGLE_ADS_RESULT_FILE || join(DIAG_DIR, `keywords-${normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID || '') || 'unknown'}.json`);
export const cid = normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID || '');
export const keywords = parseKeywords(process.env.GOOGLE_ADS_KEYWORDS || process.env.KEYWORDS || process.env.KEYWORD || '');

if (!cid) throw new Error('GOOGLE_ADS_CUSTOMER_ID required');
if (!keywords.length) throw new Error('GOOGLE_ADS_KEYWORDS required');
mkdirSync(DIAG_DIR, { recursive: true });
mkdirSync(dirname(RESULT_FILE), { recursive: true });


export function parseKeywords(value) {
  return [...new Set(String(value || '').split(/[\n,]+/).map((keyword) => keyword.trim()).filter(Boolean))];
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

export function preferredEmail() {
  return GOOGLE_ADS_LOGIN.email;
}

export async function resolveSsoCreds() {
  return { ...GOOGLE_ADS_LOGIN, source: 'skarbiec' };
}

function redact(text) {
  return String(text || '')
    .replace(/[A-Z2-7](?:\s?[A-Z2-7]){15,}/g, '<redacted-base32-secret>')
    .replace(/"login_password"\s*:\s*"[^"]+"/g, '"login_password":"<redacted>"')
    .replace(/"google_totp_secret"\s*:\s*"[^"]+"/g, '"google_totp_secret":"<redacted>"');
}

export function writeResult(report, code = 0) {
  const safe = JSON.parse(redact(JSON.stringify(report)));
  writeFileSync(RESULT_FILE, JSON.stringify(safe, null, 2));
  console.log(JSON.stringify(safe, null, 2));
  process.exit(code);
}

export function socketReady() {
  return existsSync(SOCK);
}
