// What the environment configured this server to be, decided once at startup.
//
// Every value here is a boundary the whole process is held to: the address it
// binds, the credentials it accepts, the two directories its evidence lives in,
// and what a request may ask for. They are read in one place so that a
// misconfigured host fails while the port is still closed rather than on the
// request that first happens to cross a boundary, and so that no route can
// invent a second reading of the same variable.
//
// Nothing here has a built-in value. The release launcher
// (release/stado-launcher.sh) and Stado's service declaration state the
// address, port, recordings directory and bearer; a value they do not state is
// refused by name or read as not configured, never replaced by a guess.
//
// Values that only one route understands are not here: the builder's bootstrap
// page and preamble belong to the builder route, and the Stado-published
// document paths belong to the module that reads those documents.

import { homedir } from 'node:os';
import { join } from 'node:path';

// Where a detached run records what happened, outside the repository so a
// rebuild cannot delete the answer.
export const RUN_RESULTS_DIR = join(homedir(), '.stado', 'weles-detached-runs');

// A value the declaration must state; the server does not start without it.
function declared(name, meaning) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set: set it to ${meaning}`);
  return value;
}

// A value the declaration may leave out. Unset and empty both mean "not
// configured", which each consumer answers for itself (a missing bearer is a
// misconfigured server, not an open one).
function stated(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  return value;
}

// A permission is off unless the declaration turns it on with "1".
function granted(name) {
  return process.env[name] === '1';
}

export const RECORDINGS_ROOT = declared(
  'WELES_RECORDINGS_ROOT',
  'the recordings directory the Weles release launcher exports',
);
export const HOST = declared(
  'WELES_API_HOST',
  'the address the Weles service declaration assigns',
);
export const PORT = Number(
  declared('WELES_API_PORT', 'the port the Weles service declaration assigns'),
);
export const TOKEN = stated('WELES_API_TOKEN');
export const BRAMA_REAUTH_TOKEN = stated('BRAMA_WELES_REAUTH_TOKEN');
export const ALLOW_UNAUTH = granted('WELES_API_ALLOW_UNAUTH');
// Returning a run's credentials unredacted is a grant the declaration makes,
// never the default: without WELES_API_ALLOW_RAW_CREDS=1 a "raw" request is
// refused with 403 raw_creds_forbidden and "redact" or "store" is the answer.
export const ALLOW_RAW_CREDS = granted('WELES_API_ALLOW_RAW_CREDS');

// Where the /captcha/answers/ route writes what a captcha provider pushes, and
// where each run started here waits for it; outside the repository like the
// detached runs' answers.
export const CAPTCHA_ANSWERS_DIR = join(homedir(), '.stado', 'weles-captcha-answers');

// The public HTTPS origin a captcha provider reaches this server's
// /captcha/answers/ route at (a hostname routed to this service). Unset, the
// runs started here hold no callback address and every provider solve is
// refused naming it; a value that is not an HTTPS origin stops the server.
function captchaCallbackOrigin() {
  const value = stated('WELES_CAPTCHA_CALLBACK_ORIGIN');
  if (!value) return null;
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || origin.origin !== value.replace(/\/$/, ''))
    throw new Error(
      `WELES_CAPTCHA_CALLBACK_ORIGIN is ${value}: set it to the public HTTPS origin (scheme and host, no path) routed to this server`,
    );
  return origin.origin;
}
export const CAPTCHA_CALLBACK_ORIGIN = captchaCallbackOrigin();
