// What this facade may say out loud inside the Weles process: the keeper
// session it asks for, the diagnostics directory it writes into, the keeper
// runner it spawns, and the two filters that keep Google credentials out of
// every child environment and out of every printed line. It binds no port,
// starts no keeper and takes no token of its own: the Weles API process
// serves its routes behind WELES_API_TOKEN.

import { runOutputPath } from '#run-output';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../../../../..');
// The Keyword Planner keeper runner, one directory up (`../keeper.mjs`).
export const RUNNER = join(here, '..', 'keeper.mjs');
// The keeper session a request runs in when it names none; unset, a request
// must name its own (request_intake.mjs requestSession refuses it).
export const SESSION =
  process.env.SESSION || process.env.GOOGLE_ADS_KEEPER_SESSION;
export const DIAG_DIR =
  process.env.GOOGLE_ADS_DIAG_DIR ||
  runOutputPath('google-ads-keyword-planner', 'api');

// Google's published credential prefixes: OAuth access tokens and OAuth
// client secrets.
const GOOGLE_ACCESS_TOKEN = new RegExp(String.raw`ya29\.[\w.-]+`, 'g');
const GOOGLE_CLIENT_SECRET = new RegExp(String.raw`GOCSPX-[\w-]+`, 'g');

/**
 * `text` with Google's credential shapes blanked: its access tokens and
 * client secrets by their published prefixes, and refresh tokens and TOTP
 * secrets by the JSON field that carries them. The runner blanks its own
 * login's password and TOTP secret before it writes anything.
 */
export function redact(text) {
  return text
    .replace(GOOGLE_ACCESS_TOKEN, '<redacted-google-access-token>')
    .replace(GOOGLE_CLIENT_SECRET, '<redacted-google-client-secret>')
    .replace(
      /"refresh_token"\s*:\s*"[^"]+"/g,
      '"refresh_token":"<redacted-google-refresh-token>"',
    )
    .replace(
      /"google_totp_secret"\s*:\s*"[^"]+"/g,
      '"google_totp_secret":"<redacted>"',
    );
}

// Credential variables a child must not inherit from the Weles process; the
// runner reads its own login from Skarbiec.
const AMBIENT_CREDENTIALS = new Set([
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
]);
// Any ambient username or password variable is a credential too, whichever
// provider it names.
const CREDENTIAL_SUFFIXES = ['_USER', '_USERNAME', '_PASS', '_PASSWORD'];

export function stripAmbientCredentialEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !AMBIENT_CREDENTIALS.has(key) &&
        !CREDENTIAL_SUFFIXES.some((suffix) => key.endsWith(suffix)),
    ),
  );
}
