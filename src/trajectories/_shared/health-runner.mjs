/**
 * Shared health-probe runner. Each platform supplies a config with:
 *   platform:            string — 'reddit' | 'twitter' | etc
 *   loggedInUrl:         string | (username) => string — absolute URL; captured response body parsed
 *   loggedInRegex:       RegExp — matches captured response URL to extract the body
 *   loggedOutUrl:        optional (username, signedInRead) => string — the public profile, read signed out
 *   loggedOutRegex:      RegExp — matches captured response URL of the signed-out read
 *   banDetector:         async (page, responses) => BanSignal
 *   extractLoggedIn:     (body, response) => { ok, karma, is_suspended }
 *   extractLoggedOut:    optional (response) => true when the public profile is visible,
 *                        false when it is hidden, null when the read cannot tell
 *   beforeGoto:          optional async (session, acct) => void — auth that is not a cookie
 *   afterProbe:          optional async (snapshot, acct) => void — the platform's own
 *                        consequence of a signal, run after the snapshot is written
 *
 * The account's signal is, in order: suspended when the signed-in read says
 * so; the platform detector's verdict on the signed-in page when it is not
 * healthy (proxy failures, declared sign-in and block routes, the page as the
 * model judges it, API answers including rate limits); shadowbanned when the
 * signed-in read is ok but the public profile is not visible signed out;
 * healthy when the signed-in read or the detector says so. Anything else is
 * unknown and fails the probe with what was observed. A probe whose own auth
 * setup failed observed nothing about the account and fails.
 *
 * Writes recordings/<platform>_health/<username>_<ts>.json.
 */
import {
  getSocialAccount,
  resolveAccountSession,
} from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { submitWelesRun } from '../../../dist/worker/run-submit/index.js';
import { banSignalOf, HEALTH_UNREAD } from './auth/ban-signal.mjs';
import { navigationRefusal } from './page/navigation/refused.mjs';
import { HTTP_OK } from '../../worker/weles-api-server/routes/http-status.mjs';

const INDENT = '  ';
const HEADLESS =
  process.env.HEADLESS === '1' || process.env.WELES_HEADLESS === '1';
// Account states written by registration before it completed: such an account
// has no working login, so no automatic re-login is started for it.
const UNREGISTERED = new Set([
  'captcha_blocked',
  'unverified',
  'needs_verification',
  'captcha_signup_failed',
]);

/** A captured body as JSON when it is JSON, otherwise as the text it is. */
function bodyOf(text) {
  try {
    return JSON.parse(text);
  } catch (notJson) {
    return text;
  }
}

/** One read of `url` in its own session: the matching response and its verdict. */
async function probe(session, url, matching, detector, moment) {
  const read = { url: null, status: null, body: null };
  try {
    await session.goto(url);
    const response = session.capturedResponses.find((r) =>
      matching.test(r.url),
    );
    read.url = response ? response.url : session.page.url();
    if (response) {
      read.status = response.status;
      read.body = bodyOf(response.body);
    }
  } catch (error) {
    read.error = error.message;
    read.refusal = navigationRefusal(error.message, session.page.url());
  }
  if (detector) read.signal = await banSignalOf(detector, session, moment);
  return read;
}

export async function runHealthProbe(cfg) {
  const acct = await getSocialAccount(cfg.platform);
  if (!acct)
    throw new Error(
      `HEALTH_ACCOUNT_REQUIRED: no active ${cfg.platform} account in the accounts store`,
    );
  console.log(`[health:${cfg.platform}] acct=${acct.username}`);
  const { proxyUrl, persona } = await resolveAccountSession(acct);

  const sIn = await WSession.start({
    label: `${cfg.platform}_health_in`,
    proxy: proxyUrl,
    persona,
    headless: HEADLESS,
  });
  let loggedIn;
  try {
    // The signed-in read carries the account's stored cookies, and the
    // platform's non-cookie auth when it has one; auth that cannot be set up
    // fails the probe rather than reading a signed-out page as the account.
    const stored = Array.isArray(acct.metadata?.cookies)
      ? acct.metadata.cookies.filter(
          (c) => c && c.name && c.value && (c.domain || c.url),
        )
      : [];
    if (stored.length) await sIn.ctx.addCookies(stored);
    if (cfg.beforeGoto) await cfg.beforeGoto(sIn, acct);
    loggedIn = await probe(
      sIn,
      typeof cfg.loggedInUrl === 'function'
        ? cfg.loggedInUrl(acct.username)
        : cfg.loggedInUrl,
      cfg.loggedInRegex,
      cfg.banDetector,
      'after the signed-in read',
    );
  } finally {
    await sIn.close();
  }

  // The signed-out read uses the same persona as the signed-in one, so the
  // same browser engine reads both.
  let loggedOut = null;
  if (cfg.loggedOutUrl) {
    const sOut = await WSession.start({
      label: `${cfg.platform}_health_out`,
      proxy: proxyUrl,
      persona,
      headless: HEADLESS,
    });
    try {
      loggedOut = await probe(
        sOut,
        cfg.loggedOutUrl(acct.username, loggedIn),
        cfg.loggedOutRegex,
        null,
        'after the signed-out read',
      );
    } finally {
      await sOut.close();
    }
  }

  const extracted = cfg.extractLoggedIn(loggedIn.body, loggedIn);
  // A signed-out read that failed to reach the site says nothing about
  // visibility; only one that reached it can show a hidden profile.
  const publicVisible =
    !loggedOut || loggedOut.error
      ? null
      : cfg.extractLoggedOut
        ? cfg.extractLoggedOut(loggedOut)
        : loggedOut.status === HTTP_OK;
  const shadowbanned = Boolean(extracted.ok) && publicVisible === false;
  const detected = loggedIn.signal;

  let signal;
  if (extracted.is_suspended) signal = 'suspended';
  // A detector that could not read the page decides nothing; the read's own
  // record keeps why.
  else if (detected && !detected.healthy && detected.signal !== HEALTH_UNREAD)
    signal = detected.signal;
  else if (shadowbanned) signal = 'shadowbanned';
  else if (extracted.ok || detected?.healthy) signal = 'healthy';
  else if (loggedIn.refusal && loggedIn.refusal !== 'reached')
    signal = loggedIn.refusal;
  else signal = 'unknown';

  const snapshot = {
    account_id: acct.id,
    username: acct.username,
    platform: cfg.platform,
    checked_at: new Date().toISOString(),
    signal,
    shadowbanned,
    is_suspended: Boolean(extracted.is_suspended),
    karma: extracted.karma,
    logged_in: loggedIn,
    logged_out: loggedOut,
  };

  // A checkpoint starts the platform's login for this account, unless its
  // registration never completed.
  const status = acct.metadata?.status;
  if (signal === 'checkpoint' && acct.id && UNREGISTERED.has(status)) {
    snapshot.recovery = {
      skipped: `metadata.status=${status}: registration never completed, so a login cannot recover it`,
    };
  } else if (signal === 'checkpoint' && acct.id) {
    const accountItem = acct.metadata?.login_item;
    snapshot.recovery = { accountItem };
    if (!accountItem)
      snapshot.recovery.error = `account ${acct.id} names no Skarbiec login item in metadata.login_item, so no login can be started to recover it`;
    else {
      try {
        snapshot.recovery.run = await submitWelesRun({
          action: `${cfg.platform}_login`,
          accountItem,
          params: { reason: 'auto-recovery from checkpoint health signal' },
        });
      } catch (error) {
        snapshot.recovery.error = `the login run could not be submitted: ${error.message}`;
      }
    }
  }

  const outDir = runRecordingsDir(`${cfg.platform}_health`);
  mkdirSync(outDir, { recursive: true });
  const filePath = join(
    outDir,
    `${acct.username}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(filePath, JSON.stringify(snapshot, null, INDENT));
  console.log(
    `[health:${cfg.platform}] signal=${signal} karma=${extracted.karma} shadowbanned=${shadowbanned}`,
  );
  console.log(`[health:${cfg.platform}] snapshot -> ${filePath}`);
  if (snapshot.recovery?.error)
    throw new Error(
      `HEALTH_RECOVERY_NOT_STARTED: ${acct.username} reads checkpoint and ${snapshot.recovery.error} (snapshot ${filePath})`,
    );
  if (signal === 'unknown')
    throw new Error(
      `HEALTH_UNKNOWN: the probe of ${acct.username} read neither a verdict nor a signed-in page (snapshot ${filePath})`,
    );
  if (cfg.afterProbe) await cfg.afterProbe(snapshot, acct);
  return snapshot;
}
