// How a trajectory child is placed and ended, and what both runs tell it and
// report about it: shared by the ordinary trajectory run
// (./trajectory-process.mjs) and the provider runs Brama orders
// (./reauth-process.mjs), so there is one set of rules for ending a browser.
//
// Placement is the part that is easy to get wrong. When the API runs as a
// system LaunchDaemon and a GUI login exists, a browser started straight from
// this process has no window server; the child is therefore re-entered into the
// logged-in user's GUI bootstrap first, and only when that bootstrap cannot be
// proven does the direct spawn stand.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, resolve } from 'node:path';

import { CAPTCHA_CALLBACK_ORIGIN, RECORDINGS_ROOT } from '../../configuration.mjs';
import { CAPTCHA_ANSWER_PATH, captchaAnswersOf } from '../../routes/captcha/answers.mjs';
import { REPO } from '../../release-identity.mjs';
import { runOutputs } from '../run-outcome.mjs';

export function signalRunProcess(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      // A group that already exited answers ESRCH; its direct child may
      // still be running. Any other refusal is the caller's to see.
      if (error.code !== 'ESRCH') throw error;
    }
  }
  // A child that already exited takes no signal; kill answers false for it.
  child.kill(signal);
}

export function trajectoryProcess(trajPath) {
  const direct = { command: process.execPath, args: [trajPath] };
  if (process.platform !== 'darwin') return direct;
  // Each reason the run starts in this process's own session rather than the
  // logged-in GUI session is said with its cause: a headed browser that then
  // cannot draw otherwise fails with nothing pointing here.
  let session;
  try {
    session = execFileSync('/bin/launchctl', ['managername'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    console.error(
      `[trajectory] launchctl managername failed, so this process's session is unknown: ${error.message}`,
    );
  }
  if (session === 'Aqua') return direct;
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) return direct;
  try {
    execFileSync('/bin/launchctl', ['print', `gui/${uid}`], {
      stdio: 'ignore',
    });
  } catch (error) {
    console.error(
      `[trajectory] no GUI login session gui/${uid} to run ${trajPath} in (launchctl print: ${error.message}); it runs in this process's ${session} session`,
    );
    return direct;
  }
  const username = userInfo().username;
  if (!username) return direct;
  return {
    command: '/usr/bin/sudo',
    args: [
      '-n',
      '-E',
      '/bin/launchctl',
      'asuser',
      String(uid),
      '/usr/bin/sudo',
      '-n',
      '-E',
      '-u',
      username,
      process.execPath,
      trajPath,
    ],
  };
}

// What a running run has said so far, as `GET /runs` reports it: both
// streams whole, as the finished record will keep them, and when the child
// last wrote anything. A run whose last output is an hour old is waiting on
// something its last line names. The fields keep their `_tail` names because
// they are the wire contract; the 4,000/2,000-character cut is gone.
export function liveOutput(stdout, stderr, lastOutputAt) {
  return {
    last_output_at: lastOutputAt,
    stdout_tail: stdout,
    stderr_tail: stderr,
  };
}

// `outputs` are the named documents the run left in its recording tree;
// `output_errors` appears only when one of them could not be read.
export function recordedOutputs(runId) {
  const { outputs, errors } = runOutputs(runId);
  return Object.keys(errors).length
    ? { outputs, output_errors: errors }
    : { outputs };
}

// What every trajectory child is told about its run, whichever path started
// it. The child writes recordings where this server reads them back
// (runOutputs, diagnostics); without it a trajectory falls to
// <cwd>/recordings and every recorded output reads as absent. And a run's
// verdict does not wait on a detection probe: the probe a closing session
// runs (page script, then a third-party TLS echo) sent a signed-in browser to
// another site after the provider's pages, and a run that had already
// reported stood in it -- a sign-in after its instrumentation dump, and a
// Google authenticator enrolment for twenty minutes in the probe's WebRTC
// section after it wrote its result -- while GET /runs still read `running`.
// A captcha provider pushes its answer to this server, so the child is told
// where (WELES_CAPTCHA_CALLBACK_URL, only when the server has a public
// origin) and where the answer lands (WELES_CAPTCHA_ANSWERS_DIR), both its
// own run's, which end with the run's registration; see
// src/captcha/providers/callback.ts.
export function runChildIdentity(runId, action) {
  return {
    WELES_FINGERPRINT: '0',
    WELES_RECORDINGS_ROOT: RECORDINGS_ROOT,
    WELES_CAPTCHA_ANSWERS_DIR: captchaAnswersOf(runId),
    ...(CAPTCHA_CALLBACK_ORIGIN
      ? {
          WELES_CAPTCHA_CALLBACK_URL: new URL(`${CAPTCHA_ANSWER_PATH}${runId}/`, CAPTCHA_CALLBACK_ORIGIN).toString(),
        }
      : {}),
    ACTION_LOG_ID: runId,
    ACTION: action,
  };
}

// The file src/trajectories/<provider>/<trajectory>.mjs, or null when the
// provider is not one plain path segment (it could otherwise leave
// src/trajectories) or has no such trajectory.
export function trajectoryPath(provider, trajectory) {
  if (!provider || basename(provider) !== provider || provider.startsWith('.'))
    return null;
  const path = resolve(REPO, 'src/trajectories', provider, `${trajectory}.mjs`);
  return existsSync(path) ? path : null;
}

// Every provider with a `trajectory` of its own, in name order: what a route
// that runs that trajectory serves.
export function providersWith(trajectory) {
  return readdirSync(resolve(REPO, 'src/trajectories'), { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && trajectoryPath(entry.name, trajectory),
    )
    .map((entry) => entry.name)
    .sort();
}
