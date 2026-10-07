// How a trajectory child is placed, supervised and ended.
//
// Placement is the part that is easy to get wrong. When the API runs as a
// system LaunchDaemon and a GUI login exists, a browser started straight from
// this process has no window server; the child is therefore re-entered into the
// logged-in user's GUI bootstrap first, and only when that bootstrap cannot be
// proven does the direct spawn stand.
//
// Supervision is the same in both directions of the process group: a run ends
// when its child exits, and an abort from the caller kills the group outright,
// and stdout and stderr are kept only as bounded tails so a chatty trajectory
// cannot grow the server's heap without limit.
//
// The two runs live together because they are one mechanism with two callers.
// An ordinary trajectory takes its environment from the caller's parameters; a
// provider reauth takes the vault row it must sign in and reaches the
// trajectory through the display-name selector every login trajectory already
// honours. Everything else -- placement, group kill, tail bounds, the recorded
// outcome -- is shared, and a second copy of it would be a second set of rules
// for ending a browser.

import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { RECORDINGS_ROOT, RUN_RESULTS_DIR } from '../configuration.mjs';
import { REPO, RUN_RELEASE_IDENTITY } from '../release-identity.mjs';
import {
  SAFE_RUN_ID,
  findResultDoc,
  lastJsonLine,
  persistRunResult,
  runOutputs,
} from './run-outcome.mjs';
import { credentialFailure } from './credential-outcome.mjs';
import { registerRunningRun } from './running-runs.mjs';

function signalRunProcess(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone while the direct child still exits.
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

function trajectoryProcess(trajPath) {
  const direct = { command: process.execPath, args: [trajPath] };
  if (process.platform !== 'darwin') return direct;
  let session = 'unknown';
  try {
    session = execFileSync('/bin/launchctl', ['managername'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* use direct */
  }
  if (session === 'Aqua') return direct;
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) return direct;
  try {
    execFileSync('/bin/launchctl', ['print', `gui/${uid}`], {
      stdio: 'ignore',
    });
  } catch {
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

// The exit code a run reports when its child produced none (it failed to
// spawn or ended without one); the same value the close handlers write.
const NO_EXIT_CODE = Math.sign(-Infinity);

// What a running run has said so far, as `GET /runs` reports it: both
// streams whole, as the finished record will keep them, and when the child
// last wrote anything. A run whose last output is an hour old is waiting on
// something its last line names. The fields keep their `_tail` names because
// they are the wire contract; the 4,000/2,000-character cut is gone.
function liveOutput(stdout, stderr, lastOutputAt) {
  return {
    last_output_at: lastOutputAt,
    stdout_tail: stdout,
    stderr_tail: stderr,
  };
}

// `outputs` are the named documents the run left in its recording tree;
// `output_errors` appears only when one of them could not be read.
function recordedOutputs(runId) {
  const { outputs, errors } = runOutputs(runId);
  return Object.keys(errors).length
    ? { outputs, output_errors: errors }
    : { outputs };
}

// What every trajectory child is told about its run, whichever path started
// it. The child writes recordings where this server reads them back
// (findResultDoc, runOutputs, diagnostics); without it a trajectory falls to
// <cwd>/recordings and every recorded output reads as absent. And a run's
// verdict does not wait on a detection probe: the probe a closing session
// runs (page script, then a third-party TLS echo) sent a signed-in browser to
// another site after the provider's pages, and a run that had already
// reported stood in it -- a sign-in after its instrumentation dump, and a
// Google authenticator enrolment for twenty minutes in the probe's WebRTC
// section after it wrote its result -- while GET /runs still read `running`.
function runChildIdentity(runId, action) {
  return {
    WELES_FINGERPRINT: '0',
    WELES_RECORDINGS_ROOT: RECORDINGS_ROOT,
    ACTION_LOG_ID: runId,
    ACTION: action,
  };
}

// `resolveTrajectory` and `paramsToEnv` are the deployed runtime's own dispatch
// table, resolved by the entry point: this module is never the one that names a
// path inside the release tree.
export function createTrajectoryRunner({ resolveTrajectory, paramsToEnv }) {
  return function runTrajectory(
    action,
    params,
    accountId,
    freshProfile,
    runOptions = {},
  ) {
    return new Promise((resolveRun) => {
      const trajPath = resolveTrajectory(action);
      if (!trajPath) {
        resolveRun({ ok: false, error: 'no_trajectory', action });
        return;
      }
      const runId = runOptions.runId || randomUUID();
      if (!SAFE_RUN_ID.test(runId)) {
        resolveRun({ ok: false, error: 'invalid_run_id', action });
        return;
      }
      const startedAt = new Date().toISOString();
      const runResultPath = join(RUN_RESULTS_DIR, `${runId}.json`);
      try {
        persistRunResult(runResultPath, {
          ok: null,
          ...RUN_RELEASE_IDENTITY,
          action,
          run_id: runId,
          status: 'running',
          started_at: startedAt,
        });
      } catch (error) {
        resolveRun({
          ok: false,
          error: 'run_metadata_unavailable',
          action,
          run_id: runId,
          stderr_tail: String(error?.message || error),
        });
        return;
      }
      const env = {
        ...(runOptions.childEnvironment ?? process.env),
        ...(runOptions.childEnvironment
          ? {}
          : {
              WELES_FULL_DIAGNOSTICS: process.env.WELES_FULL_DIAGNOSTICS ?? '1',
            }),
        ...paramsToEnv(params || {}, action, trajPath),
        ...(accountId ? { ACCOUNT_ID: String(accountId) } : {}),
        ...(freshProfile ? { WELES_FRESH_PROFILE: '1' } : {}),
        ...(runOptions.extraEnv || {}),
        ...runChildIdentity(runId, action),
      };
      const processSpec = trajectoryProcess(trajPath);
      const child = spawn(processSpec.command, processSpec.args, {
        cwd: REPO,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let lastOutputAt = null;
      let cancelled = false;
      let cancelDetail = null;
      let settled = false;
      // Every `STEP <name>` line the trajectory writes is a stage, as for a
      // sign-in: an enrolment that stood for minutes on a Google page said
      // only how long ago it last wrote, so nobody could tell which step held it.
      const stages = [];
      let lastStage = null;
      let pendingLine = '';
      const readStages = (chunk) => {
        const lines = `${pendingLine}${chunk}`.split('\n');
        pendingLine = lines.pop();
        for (const line of lines) {
          const step = /^STEP (?<name>\S+)\s*$/.exec(line);
          if (!step) continue;
          lastStage = { stage: step.groups.name, at: new Date().toISOString() };
          stages.push(lastStage);
          try {
            persistRunResult(runResultPath, {
              ok: null,
              ...RUN_RELEASE_IDENTITY,
              action,
              run_id: runId,
              status: 'running',
              started_at: startedAt,
              stages,
            });
          } catch {
            /* the stage is still reported live by describe() */
          }
        }
      };
      const abortRun = () => {
        cancelled = true;
        signalRunProcess(child, 'SIGKILL');
      };
      const unregister = registerRunningRun(runId, {
        action,
        kind: 'run',
        startedAt,
        cancel: (detail) => {
          cancelDetail = detail;
          abortRun();
        },
        describe: () => ({
          stage: lastStage,
          ...liveOutput(stdout, stderr, lastOutputAt),
        }),
      });
      const finish = (result) => {
        if (settled) return;
        settled = true;
        unregister();
        runOptions.signal?.removeEventListener('abort', abortRun);
        if (cancelDetail !== null)
          result = {
            ...result,
            ok: false,
            cancelled: true,
            cancel_detail: cancelDetail,
          };
        result = { ...result, stages };
        try {
          persistRunResult(runResultPath, {
            ...result,
            ...RUN_RELEASE_IDENTITY,
            action,
            run_id: runId,
            status: 'finished',
            started_at: startedAt,
            completed_at: new Date().toISOString(),
          });
        } catch (error) {
          result = {
            ...result,
            metadata_error: `run metadata could not be completed: ${String(error?.message || error)}`,
          };
        }
        resolveRun(result);
      };
      if (runOptions.signal?.aborted) abortRun();
      else
        runOptions.signal?.addEventListener('abort', abortRun, { once: true });
      child.stdout.on('data', (chunk) => {
        lastOutputAt = new Date().toISOString();
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        lastOutputAt = new Date().toISOString();
        stderr += chunk.toString();
      });
      child.stderr.on('data', (chunk) => readStages(String(chunk)));
      child.once('error', (error) => {
        finish({
          ok: false,
          exitCode: NO_EXIT_CODE,
          action,
          run_id: runId,
          result: null,
          ...recordedOutputs(runId),
          stdout_tail: stdout,
          stderr_tail: `${stderr}\n${String(error?.message || error)}`,
          cancelled,
        });
      });
      child.on('close', (code) => {
        const exitCode = cancelled ? 137 : (code ?? -1);
        const result = lastJsonLine(stdout) ?? findResultDoc(runId);
        finish({
          ok: !exitCode,
          exitCode,
          action,
          run_id: runId,
          result,
          ...recordedOutputs(runId),
          stdout_tail: stdout,
          stderr_tail: stderr,
          cancelled,
        });
      });
    });
  };
}

// Providers whose reauth trajectory can run on the host on demand. This is the
// "call Weles on the host to authenticate" step: the broker decides WHICH
// provider + method, weles-api runs that provider's reauth trajectory locally,
// and only the run status leaves the process.
export const REAUTH_PROVIDERS = new Set(['codex', 'claude', 'kimi']);

// `account` is the row this run must sign in, already resolved from the caller's
// login_item. It reaches the trajectory as <PROVIDER>_DISPLAY_NAME, which is the
// selector every reauth/login trajectory already honours, plus WELES_LOGIN_ITEM
// so the run and its report agree on which account was asked for.
//
// A sign-in drives pages until something on them changes, and some changes
// wait for a person: no clock ends that wait, so the caller is told what the
// run is doing while it does it. `onProgress` receives each event as it
// happens: `started` with the run id, `stage` for every `STEP` line the
// trajectory writes, and `operator_request` when the run opens one and so
// waits for the operator. The finished run records every stage it passed.
export function runReauth(provider, account, onProgress = () => {}) {
  return new Promise((resolveRun) => {
    const trajPath = resolve(REPO, 'src/trajectories', provider, 'reauth.mjs');
    if (!existsSync(trajPath)) {
      resolveRun({ ok: false, error: 'no_reauth_trajectory', provider });
      return;
    }
    const runId = randomUUID();
    const action = `${provider}_reauth`;
    const startedAt = new Date().toISOString();
    const runResultPath = join(RUN_RESULTS_DIR, `${runId}.json`);
    try {
      persistRunResult(runResultPath, {
        ...RUN_RELEASE_IDENTITY,
        action,
        run_id: runId,
        status: 'running',
        started_at: startedAt,
        completed_at: null,
      });
    } catch (error) {
      resolveRun({
        ok: false,
        error: 'run_metadata_unavailable',
        detail: String(error?.message || error),
        provider,
      });
      return;
    }
    const processSpec = trajectoryProcess(trajPath);
    const child = spawn(processSpec.command, processSpec.args, {
      cwd: REPO,
      env: {
        ...process.env,
        WELES_FULL_DIAGNOSTICS: process.env.WELES_FULL_DIAGNOSTICS ?? '1',
        ...runChildIdentity(runId, action),
        ...(account
          ? {
              WELES_LOGIN_ITEM: account.loginItem,
              WELES_ACCOUNT_REVISION: account.accountRevision,
              [`${provider.toUpperCase()}_DISPLAY_NAME`]: account.displayName,
              ...(account.subscriptionId
                ? { BRAMA_SUBSCRIPTION_ID: account.subscriptionId }
                : {}),
            }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let lastOutputAt = null;
    let cancelDetail = null;
    const stages = [];
    let operatorRequest = null;
    let progressRecordError = null;
    // The run's own record says where it is while it runs, so the diagnostics
    // route answers "what is it doing" for a caller that was not listening.
    const recordProgress = () => {
      try {
        persistRunResult(runResultPath, {
          ...RUN_RELEASE_IDENTITY,
          action,
          run_id: runId,
          status: 'running',
          started_at: startedAt,
          completed_at: null,
          stages,
          operator_request: operatorRequest,
        });
      } catch (error) {
        progressRecordError = `run progress could not be recorded: ${String(error?.message || error)}`;
      }
    };
    const progress = (event) => {
      try {
        onProgress(event);
      } catch {
        /* a caller that went away does not end the run */
      }
    };
    progress({
      event: 'started',
      run_id: runId,
      host: hostname(),
      started_at: startedAt,
    });
    let pendingLine = '';
    const readProgress = (chunk) => {
      const lines = `${pendingLine}${chunk}`.split('\n');
      pendingLine = lines.pop();
      for (const line of lines) {
        const at = new Date().toISOString();
        const step = /^STEP (\S+)\s*$/.exec(line);
        if (step) {
          stages.push({ stage: step[1], at });
          recordProgress();
          progress({ event: 'stage', run_id: runId, stage: step[1], at });
          continue;
        }
        if (line.startsWith('OPERATOR_REQUEST ')) {
          try {
            operatorRequest = JSON.parse(
              line.slice('OPERATOR_REQUEST '.length),
            );
          } catch (error) {
            operatorRequest = {
              unreadable: String(error?.message || error),
              line,
            };
          }
          recordProgress();
          progress({
            event: 'operator_request',
            run_id: runId,
            at,
            request: operatorRequest,
          });
        }
      }
    };
    const unregister = registerRunningRun(runId, {
      action,
      kind: 'reauth',
      startedAt,
      cancel: (detail) => {
        cancelDetail = detail;
        signalRunProcess(child, 'SIGKILL');
      },
      describe: () => ({
        provider,
        login_item: account ? account.loginItem : null,
        subscription_id: account ? account.subscriptionId || null : null,
        stage: stages.length ? stages[stages.length - 1] : null,
        operator_request: operatorRequest,
        ...liveOutput(stdout, stderr, lastOutputAt),
      }),
    });
    const finish = (result) => {
      if (settled) return;
      unregister();
      if (cancelDetail !== null) {
        // The operator ended it: nothing about the account was learned, and
        // the next sign-in is free to run.
        const stage = stages.length
          ? stages[stages.length - 1].stage
          : 'identity';
        result.ok = false;
        result.failure = {
          code: 'run_cancelled',
          stage,
          message: `the run was cancelled at stage ${stage}: ${cancelDetail}`,
          retryable: true,
          browser_started: stages.some(
            (reached) => reached.stage === 'browser_started',
          ),
        };
      }
      result.failure = result.ok
        ? null
        : (result.failure ?? credentialFailure(result));
      result.second_factor ??= result.failure?.second_factor ?? null;
      result.stages = stages;
      result.operator_request = operatorRequest;
      if (progressRecordError)
        result.progress_record_error = progressRecordError;
      settled = true;
      try {
        persistRunResult(runResultPath, {
          ...result,
          ...RUN_RELEASE_IDENTITY,
          action,
          run_id: runId,
          status: 'finished',
          started_at: startedAt,
          completed_at: new Date().toISOString(),
        });
      } catch (error) {
        result = {
          ...result,
          metadata_error: `run metadata could not be completed: ${String(error?.message || error)}`,
        };
      }
      resolveRun(result);
    };
    child.stdout.on('data', (c) => {
      lastOutputAt = new Date().toISOString();
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      const text = c.toString();
      lastOutputAt = new Date().toISOString();
      stderr += text;
      readProgress(text);
    });
    child.once('error', (error) => {
      finish({
        ok: false,
        exitCode: -1,
        provider,
        login_item: account ? account.loginItem : null,
        display_name: account ? account.displayName : null,
        subscription_id: account ? account.subscriptionId || null : null,
        run_id: runId,
        stdout_tail: stdout,
        stderr_tail: `${stderr}\n${String(error?.message || error)}`,
      });
    });
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      finish({
        ok: exitCode === 0,
        exitCode,
        failure:
          exitCode === 0 ? null : credentialFailure({ stderr_tail: stderr }),
        second_factor: lastJsonLine(stdout)?.second_factor ?? null,
        provider,
        login_item: account ? account.loginItem : null,
        display_name: account ? account.displayName : null,
        subscription_id: account ? account.subscriptionId || null : null,
        run_id: runId,
        stdout_tail: stdout,
        stderr_tail: stderr,
      });
    });
  });
}
