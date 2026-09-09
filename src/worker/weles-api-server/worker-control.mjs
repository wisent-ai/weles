// What the launchd worker is doing, and how this server starts or restarts it.
//
// The queued path runs in a separate launchd job that this API does not own; it
// can only observe it through `launchctl print` and drive it through
// `bootstrap` and `kickstart`. The difference between "not loaded", "loaded but
// not running" and "running" decides which of those two commands is correct, so
// the reading and the driving live together: a caller that guessed wrong would
// either bootstrap a job that is already there or kickstart one launchd has
// never heard of.
//
// Nothing here answers HTTP. The route that exposes these two functions decides
// the status codes and serializes concurrent control attempts.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WORKER_LABEL = process.env.WELES_WORKER_LAUNCHD_LABEL || 'com.wisent.weles-worker';
const WORKER_TARGET = `gui/${typeof process.getuid === 'function' ? process.getuid() : 0}/${WORKER_LABEL}`;
const WORKER_DOMAIN = WORKER_TARGET.slice(0, WORKER_TARGET.lastIndexOf('/'));
const WORKER_PLIST = process.env.WELES_WORKER_LAUNCHD_PLIST
  || join(process.env.HOME || homedir(), 'Library', 'LaunchAgents', `${WORKER_LABEL}.plist`);
// Milliseconds a single launchctl invocation is given before it is abandoned.
const LAUNCHCTL_CALL_LIMIT_MS = 10_000;

function runLaunchctl(args) {
  return new Promise((resolveCommand) => {
    execFile('/bin/launchctl', args, { encoding: 'utf8', timeout: LAUNCHCTL_CALL_LIMIT_MS, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      resolveCommand({
        ok: !error,
        code: error ? (error.code ?? -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '').trim().slice(0, 1000),
      });
    });
  });
}

function parseWorkerStatus(command) {
  if (!command.ok) {
    return {
      supported: true,
      label: WORKER_LABEL,
      loaded: false,
      running: false,
      pid: null,
      state: 'unloaded',
      last_exit_status: null,
    };
  }
  const state = /^\s*state = (.+)$/m.exec(command.stdout)?.[1]?.trim() || 'unknown';
  const pidMatch = /^\s*pid = (\d+)$/m.exec(command.stdout);
  const exitMatch = /^\s*last exit code = (-?\d+)$/m.exec(command.stdout);
  return {
    supported: true,
    label: WORKER_LABEL,
    loaded: true,
    running: state === 'running',
    pid: pidMatch ? Number(pidMatch[1]) : null,
    state,
    last_exit_status: exitMatch ? Number(exitMatch[1]) : null,
  };
}

export async function workerStatus() {
  if (process.platform !== 'darwin') {
    return {
      supported: false,
      label: WORKER_LABEL,
      loaded: false,
      running: false,
      pid: null,
      state: 'unsupported_platform',
      last_exit_status: null,
    };
  }
  return parseWorkerStatus(await runLaunchctl(['print', WORKER_TARGET]));
}

async function waitForWorkerRunning(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let status = await workerStatus();
  while (!status.running && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    status = await workerStatus();
  }
  return status;
}

export async function controlWorker(action) {
  const before = await workerStatus();
  if (!before.supported) {
    return { ok: false, error: 'worker_control_requires_macos', action, before };
  }
  if (action === 'start' && before.running) {
    return { ok: true, action, changed: false, before, after: before };
  }

  let command;
  if (!before.loaded) {
    if (!existsSync(WORKER_PLIST)) {
      return { ok: false, error: 'worker_launchagent_plist_missing', action, plist: WORKER_PLIST, before };
    }
    command = await runLaunchctl(['bootstrap', WORKER_DOMAIN, WORKER_PLIST]);
  } else {
    command = await runLaunchctl(action === 'restart'
      ? ['kickstart', '-k', WORKER_TARGET]
      : ['kickstart', WORKER_TARGET]);
  }
  if (!command.ok) {
    return {
      ok: false,
      error: 'launchctl_failed',
      action,
      launchctl_code: command.code,
      launchctl_stderr: command.stderr,
      before,
      after: await workerStatus(),
    };
  }

  const after = await waitForWorkerRunning();
  return {
    ok: after.running,
    ...(after.running ? {} : { error: 'worker_not_running_after_control_action' }),
    action,
    changed: true,
    before,
    after,
  };
}
