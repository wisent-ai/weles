// The provider runs Brama orders for one account -- reauth, acquire and
// authorize -- started on this host. A run takes the vault row it must sign
// in and reaches its trajectory through the display-name selector every
// login trajectory already honours; placement, group kill and the child's
// identity are ./placement.mjs.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { RUN_RESULTS_DIR } from '../../configuration.mjs';
import { REPO, RUN_RELEASE_IDENTITY } from '../../release-identity.mjs';
import { lastJsonLine, persistRunResult } from '../run-outcome.mjs';
import { credentialFailure } from '../credential-outcome.mjs';
import { registerRunningRun } from '../running-runs.mjs';
import { runProgress } from './run-progress.mjs';
import {
  liveOutput,
  providersWith,
  runChildIdentity,
  signalRunProcess,
  trajectoryPath,
  trajectoryProcess,
} from './placement.mjs';

// Providers whose reauth trajectory can run on the host on demand. This is the
// "call Weles on the host to authenticate" step: the broker decides WHICH
// provider + method, weles-api runs that provider's reauth trajectory locally,
// and only the run status leaves the process. A provider signs in exactly when
// it has src/trajectories/<provider>/reauth.mjs, as /subscriptions/acquire
// buys exactly when it has account/acquire.mjs: no list beside the
// trajectories says it.
export const REAUTH_TRAJECTORY = 'reauth';
export const REAUTH_PROVIDERS = new Set(providersWith(REAUTH_TRAJECTORY));

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
//
// The same runner carries the two other runs Brama orders for one account:
// `acquire` (buy a new account and sign it in) and `authorize` (complete one
// OAuth authorization a harness started). `trajectory` names the file under
// src/trajectories/<provider>/, `env` adds what that run is told, and the
// trajectory's last JSON line on stdout is the result's `answer`; a later line
// that began like JSON and did not parse is named in `answer_errors`.
// The second factor a document reports, or null when it names none.
const reportedFactor = (document) =>
  document && typeof document === 'object' && 'second_factor' in document
    ? document.second_factor
    : null;

export function runReauth(
  provider,
  account,
  onProgress = () => {},
  trajectory = REAUTH_TRAJECTORY,
  env = {},
) {
  return new Promise((resolveRun) => {
    const trajPath = trajectoryPath(provider, trajectory);
    if (!trajPath) {
      resolveRun({ ok: false, error: `no_${trajectory}_trajectory`, provider });
      return;
    }
    const runId = randomUUID();
    const action = `${provider}_${trajectory.replaceAll('/', '_')}`;
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
    const subscriptionId =
      account && account.subscriptionId ? account.subscriptionId : null;
    const child = spawn(processSpec.command, processSpec.args, {
      cwd: REPO,
      env: {
        ...process.env,
        ...(process.env.WELES_FULL_DIAGNOSTICS === undefined
          ? { WELES_FULL_DIAGNOSTICS: '1' }
          : {}),
        ...runChildIdentity(runId, action),
        ...(account
          ? {
              WELES_LOGIN_ITEM: account.loginItem,
              WELES_ACCOUNT_REVISION: account.accountRevision,
              [`${provider.toUpperCase()}_DISPLAY_NAME`]: account.displayName,
              ...(subscriptionId
                ? { BRAMA_SUBSCRIPTION_ID: subscriptionId }
                : {}),
            }
          : {}),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let lastOutputAt = null;
    let cancelDetail = null;
    const progress = runProgress({
      runId,
      action,
      startedAt,
      runResultPath,
      onProgress,
    });
    progress.deliver({
      event: 'started',
      run_id: runId,
      host: hostname(),
      started_at: startedAt,
    });
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
        subscription_id: subscriptionId,
        stage: progress.lastStage,
        operator_request: progress.operatorRequest,
        ...liveOutput(stdout, stderr, lastOutputAt),
      }),
    });
    const finish = (result) => {
      if (settled) return;
      unregister();
      if (cancelDetail !== null) {
        // The operator ended it: nothing about the account was learned, and
        // the next sign-in is free to run.
        const stage = progress.lastStage ? progress.lastStage.stage : 'identity';
        result.ok = false;
        result.failure = {
          code: 'run_cancelled',
          stage,
          message: `the run was cancelled at stage ${stage}: ${cancelDetail}`,
          retryable: true,
          browser_started: progress.stages.some(
            (reached) => reached.stage === 'browser_started',
          ),
        };
      }
      result.failure = result.ok
        ? null
        : (result.failure ?? credentialFailure(result));
      if (reportedFactor(result) === null)
        result.second_factor = reportedFactor(result.failure);
      result.stages = progress.stages;
      result.operator_request = progress.operatorRequest;
      if (progress.recordError)
        result.progress_record_error = progress.recordError;
      if (progress.deliveryError)
        result.progress_delivery_error = progress.deliveryError;
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
      progress.read(text);
    });
    child.once('error', (error) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        provider,
        login_item: account ? account.loginItem : null,
        display_name: account ? account.displayName : null,
        subscription_id: subscriptionId,
        run_id: runId,
        stdout_tail: stdout,
        stderr_tail: `${stderr}\n${String(error?.message || error)}`,
      });
    });
    child.on('close', (code, signal) => {
      const printed = lastJsonLine(stdout);
      const ok = !code && signal === null;
      finish({
        ok,
        exitCode: code,
        signal,
        failure: ok ? null : credentialFailure({ stderr_tail: stderr }),
        second_factor: reportedFactor(printed.result),
        answer: printed.result,
        ...(printed.unparsed.length ? { answer_errors: printed.unparsed } : {}),
        provider,
        login_item: account ? account.loginItem : null,
        display_name: account ? account.displayName : null,
        subscription_id: subscriptionId,
        run_id: runId,
        stdout_tail: stdout,
        stderr_tail: stderr,
      });
    });
  });
}
