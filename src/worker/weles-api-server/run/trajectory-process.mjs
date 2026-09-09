// How a trajectory child is placed, supervised and ended.
//
// Placement is the part that is easy to get wrong. When the API runs as a
// system LaunchDaemon and a GUI login exists, a browser started straight from
// this process has no window server; the child is therefore re-entered into the
// logged-in user's GUI bootstrap first, and only when that bootstrap cannot be
// proven does the direct spawn stand.
//
// Supervision is the same in both directions of the process group: a deadline
// or an abort signals the group, then hard-kills what is left after a grace
// period, and stdout and stderr are kept only as bounded tails so a chatty
// trajectory cannot grow the server's heap without limit.
//
// The two runs live together because they are one mechanism with two callers.
// An ordinary trajectory takes its environment from the caller's parameters; a
// provider reauth takes the vault row it must sign in and reaches the
// trajectory through the display-name selector every login trajectory already
// honours. Everything else -- placement, deadline, group kill, tail bounds, the
// recorded outcome -- is shared, and a second copy of it would be a second set
// of rules for killing a browser that will not close.

import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { RUN_RESULTS_DIR } from '../configuration.mjs';
import { REPO, RUN_RELEASE_IDENTITY } from '../release-identity.mjs';
import { SAFE_RUN_ID, findResultDoc, lastJsonLine, persistRunResult } from './run-outcome.mjs';
import { credentialFailure } from './credential-outcome.mjs';

function signalRunProcess(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone while the direct child still exits.
    }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

function trajectoryProcess(trajPath) {
  const direct = { command: process.execPath, args: [trajPath] };
  if (process.platform !== 'darwin') return direct;
  let session = 'unknown';
  try {
    session = execFileSync('/bin/launchctl', ['managername'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* use direct */ }
  if (session === 'Aqua') return direct;
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) return direct;
  try { execFileSync('/bin/launchctl', ['print', `gui/${uid}`], { stdio: 'ignore' }); } catch { return direct; }
  const username = userInfo().username;
  if (!username) return direct;
  return {
    command: '/usr/bin/sudo',
    args: ['-n', '-E', '/bin/launchctl', 'asuser', String(uid), '/usr/bin/sudo', '-n', '-E', '-u', username, process.execPath, trajPath],
  };
}

function boundedOutputTail(current, chunk, maximumCharacters) {
  const next = `${current}${chunk.toString()}`;
  return next.length <= maximumCharacters ? next : next.slice(-maximumCharacters);
}

// `resolveTrajectory` and `paramsToEnv` are the deployed runtime's own dispatch
// table, resolved by the entry point: this module is never the one that names a
// path inside the release tree.
export function createTrajectoryRunner({ resolveTrajectory, paramsToEnv }) {
  return function runTrajectory(action, params, accountId, freshProfile, timeoutMs, runOptions = {}) {
    return new Promise((resolveRun) => {
      const trajPath = resolveTrajectory(action);
      if (!trajPath) { resolveRun({ ok: false, error: 'no_trajectory', action }); return; }
      const runId = runOptions.runId || randomUUID();
      if (!SAFE_RUN_ID.test(runId)) { resolveRun({ ok: false, error: 'invalid_run_id', action }); return; }
      const startedAt = new Date().toISOString();
      const runResultPath = join(RUN_RESULTS_DIR, `${runId}.json`);
      try {
        persistRunResult(runResultPath, { ok: null, ...RUN_RELEASE_IDENTITY, action, run_id: runId, status: 'running', started_at: startedAt });
      } catch (error) {
        resolveRun({ ok: false, error: 'run_metadata_unavailable', action, run_id: runId, stderr_tail: String(error?.message || error).slice(0, 300) });
        return;
      }
      const env = {
        ...(runOptions.childEnvironment ?? process.env),
        ...(runOptions.childEnvironment ? {} : { WELES_FULL_DIAGNOSTICS: process.env.WELES_FULL_DIAGNOSTICS ?? '1' }),
        ...paramsToEnv(params || {}, action, trajPath),
        ...(accountId ? { ACCOUNT_ID: String(accountId) } : {}),
        ...(freshProfile ? { WELES_FRESH_PROFILE: '1' } : {}),
        ...(runOptions.extraEnv || {}),
        ACTION_LOG_ID: runId,
        ACTION: action,
      };
      const processSpec = trajectoryProcess(trajPath);
      const child = spawn(processSpec.command, processSpec.args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      const abortRun = () => {
        cancelled = true;
        signalRunProcess(child, 'SIGTERM');
        const hardKill = setTimeout(() => signalRunProcess(child, 'SIGKILL'), 8000);
        hardKill.unref();
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        runOptions.signal?.removeEventListener('abort', abortRun);
        try {
          persistRunResult(runResultPath, { ...result, ...RUN_RELEASE_IDENTITY, action, run_id: runId, status: 'finished', started_at: startedAt, completed_at: new Date().toISOString() });
        } catch (error) {
          result = { ...result, metadata_error: `run metadata could not be completed: ${String(error?.message || error).slice(0, 240)}` };
        }
        resolveRun(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        signalRunProcess(child, 'SIGTERM');
        const hardKill = setTimeout(() => signalRunProcess(child, 'SIGKILL'), 8000);
        hardKill.unref();
      }, timeoutMs);
      timer.unref();
      if (runOptions.signal?.aborted) abortRun();
      else runOptions.signal?.addEventListener('abort', abortRun, { once: true });
      child.stdout.on('data', (chunk) => { stdout = boundedOutputTail(stdout, chunk, 2 * 1024 * 1024); });
      child.stderr.on('data', (chunk) => { stderr = boundedOutputTail(stderr, chunk, 512 * 1024); });
      child.once('error', (error) => {
        finish({ ok: false, exitCode: -1, action, run_id: runId, result: null, stdout_tail: stdout.slice(-4000), stderr_tail: `${stderr}\n${String(error?.message || error)}`.slice(-2000), timed_out: false, cancelled });
      });
      child.on('close', (code) => {
        const exitCode = timedOut || cancelled ? 137 : (code ?? -1);
        const result = lastJsonLine(stdout) ?? findResultDoc(runId);
        finish({ ok: exitCode === 0, exitCode, action, run_id: runId, result, stdout_tail: stdout.slice(-4000), stderr_tail: stderr.slice(-2000), timed_out: timedOut, cancelled });
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
export function runReauth(provider, timeoutMs, account) {
  return new Promise((resolveRun) => {
    const trajPath = resolve(REPO, 'src/trajectories', provider, 'reauth.mjs');
    if (!existsSync(trajPath)) { resolveRun({ ok: false, error: 'no_reauth_trajectory', provider }); return; }
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
        detail: String(error?.message || error).slice(0, 240),
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
        ACTION_LOG_ID: runId,
        ACTION: action,
        ...(account
          ? {
            WELES_LOGIN_ITEM: account.loginItem,
            WELES_ACCOUNT_SOURCE_REVISION: account.sourceRevision,
            [`${provider.toUpperCase()}_DISPLAY_NAME`]: account.displayName,
            ...(account.subscriptionId ? { BRAMA_SUBSCRIPTION_ID: account.subscriptionId } : {}),
          }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = ''; let stderr = ''; let killed = false; let settled = false;
    const finish = (result) => {
      if (settled) return;
      result.failure = result.ok ? null : credentialFailure(result);
      settled = true;
      clearTimeout(timer);
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
          metadata_error: `run metadata could not be completed: ${String(error?.message || error).slice(0, 240)}`,
        };
      }
      resolveRun(result);
    };
    const timer = setTimeout(() => {
      killed = true;
      signalRunProcess(child, 'SIGTERM');
      const hardKill = setTimeout(() => signalRunProcess(child, 'SIGKILL'), 8000);
      hardKill.unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.once('error', (error) => {
      finish({
        ok: false,
        exitCode: -1,
        provider,
        login_item: account ? account.loginItem : null,
        display_name: account ? account.displayName : null,
        subscription_id: account ? (account.subscriptionId || null) : null,
        run_id: runId,
        stdout_tail: stdout.slice(-4000),
        stderr_tail: `${stderr}\n${String(error?.message || error)}`.slice(-2000),
        timed_out: false,
      });
    });
    child.on('close', (code) => {
      const exitCode = killed ? 137 : (code ?? -1);
      finish({
        ok: exitCode === 0,
        exitCode,
        provider,
        login_item: account ? account.loginItem : null,
        display_name: account ? account.displayName : null,
        subscription_id: account ? (account.subscriptionId || null) : null,
        run_id: runId,
        stdout_tail: stdout.slice(-4000),
        stderr_tail: stderr.slice(-2000),
        timed_out: killed,
      });
    });
  });
}
