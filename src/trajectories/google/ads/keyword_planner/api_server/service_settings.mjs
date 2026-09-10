// Where this facade runs and what it may say out loud: the listening address,
// the caller's token, the keeper session and browser profile it supervises, the
// diagnostics directory it writes into, and the two filters that keep Google
// credentials out of every child environment and out of every printed line.

import { runOutputPath } from '#run-output';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../../../../..');
export const RUNNER = join(here, '../ads_keyword_planner_keeper.mjs');
export let HOST = process.env.WELES_KEYWORD_PLANNER_API_HOST || '127.0.0.1';
export let PORT = Number(process.env.WELES_KEYWORD_PLANNER_API_PORT || 8787);
export let SESSION = process.env.SESSION || process.env.GOOGLE_ADS_KEEPER_SESSION || 'google_ads';
export let API_TOKEN = process.env.WELES_KEYWORD_PLANNER_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || '';
export let ALLOW_UNAUTH = process.env.WELES_KEYWORD_PLANNER_API_ALLOW_UNAUTH === '1';
export let BODY_LIMIT_BYTES = Number(process.env.WELES_KEYWORD_PLANNER_API_BODY_LIMIT_BYTES || 128 * 1024);
export let DIAG_DIR = process.env.GOOGLE_ADS_DIAG_DIR || runOutputPath('google-ads-keyword-planner', 'api');
export const KEEPER = join(REPO, 'src/_shared/keeper/keeper.mjs');
export let KEEPER_START = process.env.GOOGLE_ADS_KEEPER_START !== '0';
export let KEEPER_READY_TIMEOUT_MS = Number(process.env.GOOGLE_ADS_KEEPER_READY_TIMEOUT_MS || 90 * 1000);
export let KEEPER_USER_DATA_DIR = process.env.GOOGLE_ADS_KEEPER_USER_DATA_DIR
  || process.env.KEEPER_USER_DATA_DIR
  || process.env.WELES_USER_DATA_DIR
  || join(process.env.HOME || '', '.weles', 'browser_profiles', 'google_ads');

HOST = process.env.WELES_KEYWORD_PLANNER_API_HOST || HOST;
PORT = Number(process.env.WELES_KEYWORD_PLANNER_API_PORT || PORT);
SESSION = process.env.SESSION || process.env.GOOGLE_ADS_KEEPER_SESSION || SESSION;
API_TOKEN = process.env.WELES_KEYWORD_PLANNER_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || API_TOKEN;
ALLOW_UNAUTH = process.env.WELES_KEYWORD_PLANNER_API_ALLOW_UNAUTH === '1' || ALLOW_UNAUTH;
BODY_LIMIT_BYTES = Number(process.env.WELES_KEYWORD_PLANNER_API_BODY_LIMIT_BYTES || BODY_LIMIT_BYTES);
DIAG_DIR = process.env.GOOGLE_ADS_DIAG_DIR || DIAG_DIR;
KEEPER_START = process.env.GOOGLE_ADS_KEEPER_START !== '0' && KEEPER_START;
KEEPER_READY_TIMEOUT_MS = Number(process.env.GOOGLE_ADS_KEEPER_READY_TIMEOUT_MS || KEEPER_READY_TIMEOUT_MS);
KEEPER_USER_DATA_DIR = process.env.GOOGLE_ADS_KEEPER_USER_DATA_DIR
  || process.env.KEEPER_USER_DATA_DIR
  || process.env.WELES_USER_DATA_DIR
  || KEEPER_USER_DATA_DIR;

export function redact(text) {
  return String(text || '')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '<redacted-google-access-token>')
    .replace(/GOCSPX-[A-Za-z0-9_-]+/g, '<redacted-google-client-secret>')
    .replace(/[A-Z2-7](?:\s?[A-Z2-7]){15,}/g, '<redacted-base32-secret>')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"<redacted-google-refresh-token>"')
    .replace(/"google_totp_secret"\s*:\s*"[^"]+"/g, '"google_totp_secret":"<redacted>"');
}

export function stripAmbientCredentialEnv(env) {
  const next = { ...env };
  const exactAmbientKeys = [
    'GOOGLE_ADS_ACCESS_TOKEN',
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_REFRESH_TOKEN',
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
  for (const key of exactAmbientKeys) delete next[key];
  for (const key of Object.keys(next)) {
    if (/^(?:OXYLABS|BRIGHTDATA)_(?:.*(?:USERNAME|PASSWORD|USER|PASS))$/.test(key)) delete next[key];
  }
  return next;
}
