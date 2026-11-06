// How an ordinary trajectory child is started, supervised and ended.
//
// Supervision is the same in both directions of the process group: a run ends
// when its child exits, and an abort from the caller kills the group outright.
// Placement, group kill and the child's identity are ./placement.mjs, shared
// with the provider runs Brama orders (./reauth-process.mjs).
//
// A finished run reports the child's own exit: exitCode is the status it
// exited with and signal the signal that ended it, each null when the child
// did not end that way (a cancelled run is ended by SIGKILL; a child that
// never started has neither). result is the last JSON line the child printed,
// else a generic browser task's generic_task_result.json from the run's
// outputs; a result file that cannot be read is named in output_errors, and a
// line after the result that began like JSON and did not parse in result_errors.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { RUN_RESULTS_DIR } from '../../configuration.mjs';
import { REPO, RUN_RELEASE_IDENTITY } from '../../release-identity.mjs';
import {
  SAFE_RUN_ID,
  lastJsonLine,
  persistRunResult,
} from '../run-outcome.mjs';
import { registerRunningRun } from '../running-runs.mjs';
import {
  liveOutput,
  recordedOutputs,
  runChildIdentity,
  signalRunProcess,
  trajectoryProcess,
} from './placement.mjs';

/**
 * The child's environment: the caller's, or this process's (a routed run
 * records full diagnostics unless the host's own WELES_FULL_DIAGNOSTICS says
 * otherwise), then the run's own.
 */
function childEnvironment(
  runOptions,
  params,
  action,
  trajPath,
  accountId,
  freshProfile,
  runId,
  paramsToEnv,
) {
  const base = runOptions.childEnvironment
    ? runOptions.childEnvironment
    : {
        ...process.env,
        ...(process.env.WELES_FULL_DIAGNOSTICS === undefined
          ? { WELES_FULL_DIAGNOSTICS: '1' }
          : {}),
      };
  return {
    ...base,
    ...paramsToEnv(params ? params : {}, action, trajPath),
    ...(accountId ? { ACCOUNT_ID: String(accountId) } : {}),
    ...(freshProfile ? { WELES_FRESH_PROFILE: '1' } : {}),
    ...runOptions.extraEnv,
    ...runChildIdentity(runId, action),
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
      const runId = runOptions.runId ? runOptions.runId : randomUUID();
      if (!SAFE_RUN_ID.test(runId)) {
        resolveRun({ ok: false, error: 'invalid_run_id', action });
        return;
      }
      const startedAt = new Date().toISOString();
      const runResultPath = join(RUN_RESULTS_DIR, `${runId}.json`);
      let trajectory;
      const running = (fields) =>
        persistRunResult(runResultPath, {
          ok: null,
          ...RUN_RELEASE_IDENTITY,
          ...trajectory,
          action,
          run_id: runId,
          status: 'running',
          started_at: startedAt,
          ...fields,
        });
      try {
        // The trajectory's version is the SHA-256 of the file this run
        // executes, read from the release tree it runs from: a release
        // carries no git history, and the digest changes exactly when the
        // trajectory's code does (FIPS 180-4,
        // https://csrc.nist.gov/pubs/fips/180-4/upd1/final).
        const trajectoryFile = resolve(REPO, trajPath);
        trajectory = {
          trajectory_path: relative(REPO, trajectoryFile),
          trajectory_version: createHash('sha256')
            .update(readFileSync(trajectoryFile))
            .digest('hex'),
        };
        running({});
      } catch (error) {
        resolveRun({
          ok: false,
          error: 'run_metadata_unavailable',
          action,
          run_id: runId,
          stderr_tail: error.message,
        });
        return;
      }
      const processSpec = trajectoryProcess(trajPath);
      const child = spawn(processSpec.command, processSpec.args, {
        cwd: REPO,
        env: childEnvironment(
          runOptions,
          params,
          action,
          trajPath,
          accountId,
          freshProfile,
          runId,
          paramsToEnv,
        ),
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
      // A stage the result file could not take is still reported live by
      // describe() and is named in the finished result.
      const stages = [];
      const stageRecordErrors = [];
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
            running({ stages });
          } catch (error) {
            stageRecordErrors.push({
              stage: lastStage.stage,
              error: error.message,
            });
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
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        unregister();
        runOptions.signal?.removeEventListener('abort', abortRun);
        let result = {
          ...outcome,
          ...(cancelDetail === null
            ? {}
            : { ok: false, cancelled: true, cancel_detail: cancelDetail }),
          ...(stageRecordErrors.length
            ? { stage_record_errors: stageRecordErrors }
            : {}),
          stages,
        };
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
            metadata_error: `run metadata could not be completed: ${error.message}`,
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
        readStages(String(chunk));
      });
      child.once('error', (error) => {
        finish({
          ok: false,
          exitCode: null,
          signal: null,
          action,
          run_id: runId,
          result: null,
          ...recordedOutputs(runId),
          stdout_tail: stdout,
          stderr_tail: `${stderr}\n${error.message}`,
          cancelled,
        });
      });
      child.on('close', (code, signal) => {
        const recorded = recordedOutputs(runId);
        const printed = lastJsonLine(stdout);
        finish({
          ok: !cancelled && !code && signal === null,
          exitCode: code,
          signal,
          action,
          run_id: runId,
          result:
            printed.result === null && recorded.outputs.generic_browser_task
              ? recorded.outputs.generic_browser_task
              : printed.result,
          ...(printed.unparsed.length
            ? { result_errors: printed.unparsed }
            : {}),
          ...recorded,
          stdout_tail: stdout,
          stderr_tail: stderr,
          cancelled,
        });
      });
    });
  };
}
