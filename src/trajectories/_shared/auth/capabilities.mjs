// The capabilities a trajectory needs, declared in one file and verified here.
//
// A headed browser is a client of the WindowServer, and whether one exists is
// decided by the launchd session the process belongs to: `Aqua` is a logged-in
// graphical session and has one, `Background` -- what a LaunchDaemon and an SSH
// command both get -- does not. Chromium started there does reach the network
// and does render pages, so every content probe passes; it dies when it creates
// its first window, and Playwright reports only that the browser disconnected.
//
// The check used to be a bare "this login needs Aqua" written into each login.
// That is the shape that cost weeks: the need existed in a comment and in one
// runner, so no scheduler, no placement decision and no operator could see it.
// It now comes from `src/trajectories/requirements.json`, the same file
// placement reads, and this module is only its reader on the host that runs.
//
// Two readers, deliberately: placement reads the whole file to choose a host, and
// this one runs inside the trajectory. The reauth runners declare `display`
// because their burnt-pool path spawns a login that opens a browser, yet they do
// not call requireCapabilities at their own start: a reauth that can donate an
// existing token needs no window, and refusing it on a display-less host would
// break the cheap path to protect the expensive one. The login it spawns checks
// for itself.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIREMENTS_FILE = process.env.WELES_TRAJECTORY_REQUIREMENTS_FILE
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'requirements.json');
const REQUIREMENTS_SCHEMA = 'wisent.trajectory-requirements.v1';

export function launchdSession() {
  try {
    return execFileSync('/bin/launchctl', ['managername'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// What this trajectory declares. An undeclared trajectory is refused rather than
// waved through: the whole point of the file is that a browser login which needs
// a display says so where every layer can read it, and a quiet default would
// restore the guessing this replaces.
export function trajectoryRequirements(trajectory) {
  if (!existsSync(REQUIREMENTS_FILE)) {
    throw new Error(`no trajectory requirements file at ${REQUIREMENTS_FILE}`);
  }
  const document = JSON.parse(readFileSync(REQUIREMENTS_FILE, 'utf8'));
  if (document?.schema !== REQUIREMENTS_SCHEMA) {
    throw new Error(`${REQUIREMENTS_FILE} declares schema '${document?.schema}', expected '${REQUIREMENTS_SCHEMA}'`);
  }
  const declared = document?.trajectories?.[trajectory];
  if (!Array.isArray(declared)) {
    throw new Error(
      `${trajectory} is not declared in ${REQUIREMENTS_FILE}, so nothing can place it. `
      + 'Add it there with the capability ids it needs, or an empty list if it needs none.',
    );
  }
  return declared;
}

// Whether a process started the way this one was can own a window right now.
// macOS: the launchd session decides, and `launchctl print gui/<uid>` is the
// second half -- a session can name itself Aqua while its GUI domain is gone.
// Linux: a display the worker can actually reach, which on a fleet host is the
// virtual one its launcher starts rather than a human's session.
function measureDisplay() {
  const platform = os.platform();
  if (platform === 'darwin') {
    const session = launchdSession();
    const uid = process.getuid?.() ?? -1;
    let guiDomain = false;
    try {
      execFileSync('/bin/launchctl', ['print', `gui/${uid}`], { stdio: 'ignore' });
      guiDomain = true;
    } catch {
      guiDomain = false;
    }
    const value = session === 'Aqua' && guiDomain;
    return {
      value,
      detail: `launchd session ${session}; gui/${uid} ${guiDomain ? 'present' : 'absent'}`,
      remedy: 'Run it from a logged-in graphical session: a LaunchAgent in '
        + `gui/${uid === -1 ? '<uid>' : uid}, not a LaunchDaemon and not a bare SSH command.`,
    };
  }
  if (platform === 'linux') {
    const display = process.env.DISPLAY ?? '';
    const remedy = 'Start it under the deployment\'s own display: src/worker/deploy/launch.sh '
      + 'execs the worker under xvfb-run, and src/worker/deploy/install-virtual-display-linux.sh '
      + 'installs that mechanism on a host that lacks it.';
    if (display) {
      // xdpyinfo proves a server answered; a bare socket only proves something
      // bound the path, which is what a half-dead Xvfb leaves behind, so the
      // socket is read only when xdpyinfo has no answer.
      try {
        execFileSync('xdpyinfo', ['-display', display], { stdio: 'ignore' });
        return { value: true, detail: `X display ${display} answered xdpyinfo`, remedy };
      } catch (error) {
        console.error(`xdpyinfo did not answer for ${display}: ${error.message.split('\n')[0]}`);
      }
      const screen = display.match(/:(\d+)/);
      const socket = screen ? `/tmp/.X11-unix/X${screen[1]}` : null;
      if (socket && existsSync(socket)) {
        return { value: true, detail: `X socket ${socket} present for DISPLAY=${display}`, remedy };
      }
      return { value: false, detail: `DISPLAY=${display} but no X server answered it`, remedy };
    }
    const wayland = process.env.WAYLAND_DISPLAY ?? '';
    const runtimeDir = process.env.XDG_RUNTIME_DIR ?? '';
    const waylandSocket = wayland.startsWith('/')
      ? wayland
      : (wayland && runtimeDir ? path.join(runtimeDir, wayland) : '');
    if (waylandSocket && existsSync(waylandSocket)) {
      return { value: true, detail: `Wayland socket ${waylandSocket} present`, remedy };
    }
    return { value: false, detail: 'no DISPLAY and no reachable Wayland socket in this environment', remedy };
  }
  return {
    value: false,
    detail: `platform ${platform} has no display check here`,
    remedy: 'Teach measureDisplay() how this platform exposes a display before running headed work on it.',
  };
}

// One measurement per capability id. `browser-render` is deliberately not a
// probe: the launch that follows this call is the measurement, and starting a
// second browser to ask the same question would double a two-minute cost and
// could still answer for a different profile than the run uses.
const CAPABILITY_MEASUREMENTS = {
  display: measureDisplay,
  'browser-render': () => ({
    value: true,
    detail: 'the browser launch that follows is the measurement; no second launch is made here',
    remedy: 'If the browser fails to render, that failure is the measurement and belongs in the host capability object.',
  }),
  os: () => ({
    value: true,
    detail: `${os.platform()} ${os.release()} ${os.arch()}`,
    remedy: 'No remedy: a running process proves its own operating system.',
  }),
};

// Verify every capability this trajectory declared, before anything expensive
// starts. Returns the measurements so a caller may log what it stood on.
export function requireCapabilities(trajectory) {
  const required = trajectoryRequirements(trajectory);
  const measured = {};
  for (const capability of required) {
    const measure = CAPABILITY_MEASUREMENTS[capability];
    if (!measure) {
      throw new Error(
        `${trajectory} declares capability '${capability}' in ${REQUIREMENTS_FILE} and nothing here can verify it. `
        + `Verifiable ids: ${Object.keys(CAPABILITY_MEASUREMENTS).join(', ')}.`,
      );
    }
    const result = measure();
    measured[capability] = result;
    if (!result.value) {
      throw new Error(
        `${trajectory} needs capability '${capability}', declared in ${REQUIREMENTS_FILE}, `
        + `and this host measures ${capability}=false: ${result.detail}. ${result.remedy}`,
      );
    }
  }
  return measured;
}
