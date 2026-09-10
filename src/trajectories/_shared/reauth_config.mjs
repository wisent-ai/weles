// Reauth configuration, read from and written to Skarbiec — the one credential
// store this fleet has. The Supabase project these orchestrators were written
// against is gone; nothing here reads a database.
//
// Two facts about the shape, both learned from the rows themselves:
//   - `fields.value.metadata` carries the map the runners read, and it is a JSON
//     string in some rows and an object in others;
//   - the agent identity and HMAC secret in it belong to the wisent-app agent,
//     not to one provider, so a row that lacks them may borrow them from a
//     sibling row rather than keeping a second copy of the same secret.
//
// Nothing here prints a secret. The router address never comes from a row: it
// is resolved through Stado, and it is logged.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeSkarbiecBinary } from '../../_shared/skarbiec-runtime.mjs';

const HOME = os.homedir();
const SKARBIEC = activeSkarbiecBinary();
const VAULT = process.env.SKARBIEC_VAULT_FILE ?? path.join(HOME, '.stado', 'skarbiec.vault.json');
const STADO = process.env.STADO_BIN ?? path.join(HOME, '.stado', 'bin', 'stado');
// What a row must carry. The signing secret is deliberately not here: it belongs
// to the agent's own item, the copies in these rows had drifted, and requiring a
// copy would mean requiring the trap to stay in place.
const REQUIRED = [
  'WISENT_APP_AGENT_ID',
  'WISENT_DONOR_USER_ID',
];


// Where Brama is, answered by Stado. The launcher-injected
// STADO_MODEL_ROUTER_URL wins where a unit carries it; a bare unit (the
// launchd reauth jobs get only HOME and PATH) asks this host's Stado service
// directory. The address belongs to placement, and placement is Stado's — a
// configuration row remembers identity, never a route.
export function stadoRouterUrl() {
  const fromEnv = String(process.env.STADO_MODEL_ROUTER_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const raw = execFileSync(STADO, ['service', 'directory', 'endpoint', 'brama', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  });
  const url = String(JSON.parse(raw)?.url ?? '').trim();
  if (!url) throw new Error('Stado answered no endpoint for brama');
  return url.replace(/\/+$/, '');
}

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
// placement reads, and this function is only its reader on the host that runs.
//
// Two readers, deliberately: placement reads the whole file to choose a host, and
// this one runs inside the trajectory. The reauth runners declare `display`
// because their burnt-pool path spawns a login that opens a browser, yet they do
// not call this function at their own start: a reauth that can donate an existing
// token needs no window, and refusing it on a display-less host would break the
// cheap path to protect the expensive one. The login it spawns checks for itself.
const REQUIREMENTS_FILE = process.env.WELES_TRAJECTORY_REQUIREMENTS_FILE
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'requirements.json');
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
// a display says so where every layer can read it, and a silent default would
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
      // bound the path, which is what a half-dead Xvfb leaves behind.
      try {
        execFileSync('xdpyinfo', ['-display', display], { stdio: 'ignore' });
        return { value: true, detail: `X display ${display} answered xdpyinfo`, remedy };
      } catch { /* fall through to the socket, which is weaker but still evidence */ }
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

function skarbiec(args, input) {
  return execFileSync(SKARBIEC, args, {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKARBIEC_VAULT_FILE: VAULT,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  });
}

function readItem(item) {
  const document = JSON.parse(skarbiec(['get', item]));
  const value = document?.fields?.value;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const raw = parsed?.metadata;
  const metadata = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { document, parsed, metadata: metadata ?? null, metadataWasText: typeof raw === 'string' };
}

// The row named first wins; a row that carries no metadata contributes nothing.
// `fallbackItem` exists for the identity keys, which are the same for every
// provider this agent donates for.
export function loadFromSkarbiec(item, fallbackItem) {
  const own = readItem(item);
  let metadata = own.metadata ? { ...own.metadata } : {};
  if (fallbackItem) {
    const sibling = readItem(fallbackItem);
    if (sibling.metadata) {
      for (const [key, value] of Object.entries(sibling.metadata)) {
        if (metadata[key] === undefined) metadata[key] = value;
      }
    }
  }
  const missing = REQUIRED.filter((key) => !metadata[key]);
  if (missing.length) {
    throw new Error(`${item} carries no ${missing.join(', ')} in Skarbiec`);
  }
  const agentId = metadata.WISENT_APP_AGENT_ID;
  // The signing secret belongs to the agent, not to a provider row, and the
  // copy inside this row is stale: Brama answered 200 to a read signed with
  // `agent:<id>` and 401 to the same read signed with the row's copy. Read the
  // agent's own item and keep the row's copy out of the signature entirely.
  const own_secret = resolveAgentSecret(agentId);
  const copy = metadata.WISENT_APP_AGENT_AUTH_SECRET;
  if (own_secret && copy && own_secret !== copy) {
    console.error(
      `agent:${agentId} carries a different secret than ${item}; signing with the agent item`,
    );
  }
  return {
    store: 'skarbiec',
    item,
    metadataWasText: own.metadataWasText,
    agentId,
    hmacSecret: own_secret || metadata.WISENT_APP_AGENT_AUTH_SECRET,
    donorUserId: metadata.WISENT_DONOR_USER_ID,
    rawMeta: metadata,
    activeTokenExpiresAt: Number(metadata.active_token_expires_at) || 0,
  };
}

// The agent's signing secret, from the one item that owns it.
export function resolveAgentSecret(agentId) {
  const fromEnv = process.env.WISENT_APP_AGENT_AUTH_SECRET;
  if (fromEnv) return fromEnv;
  try {
    const document = JSON.parse(skarbiec(['get', `agent:${agentId}`]));
    const fields = document?.fields ?? {};
    const secret = fields.value ?? fields.secret ?? fields.token;
    return typeof secret === 'string' && secret.trim() ? secret.trim() : null;
  } catch (error) {
    console.error(`no agent secret: agent:${agentId} unreadable (${error.message.split('\n')[0]})`);
    return null;
  }
}

// Merge, never replace: this map also carries the identity and the HMAC secret,
// and a bare write would take them with it.
export function persistToSkarbiec(cfg, patch) {
  const { document, parsed, metadataWasText } = readItem(cfg.item);
  const metadata = { ...(cfg.rawMeta ?? {}), ...patch };
  parsed.metadata = metadataWasText ? JSON.stringify(metadata) : metadata;
  document.fields.value = parsed;
  skarbiec(['set-json', cfg.item], JSON.stringify(document));
}
// Account material for a provider login, from the vault item that holds it.
//
// The login helpers read these rows out of the Weles database; the same
// accounts are in Skarbiec as `login` items with `username` and `password`
// fields and the method in their context. A helper that only knows the database
// fails with "no login row" while the credential sits one read away.
export function loginFromSkarbiec(item) {
  const document = JSON.parse(skarbiec(['get', item]));
  const fields = document?.fields ?? {};
  const email = fields.username ?? fields.email;
  const password = fields.password;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw new Error(`${item} carries no username/password in Skarbiec`);
  }
  return {
    id: item,
    displayName: document?.context?.account_ref ?? item,
    email,
    password,
    loginMethod: document?.context?.login_method ?? 'google_sso',
  };
}

// Whether an answer to `/v1/models` came from the model router itself.
//
// Brama serves the catalogue as `{"object":"list","data":[...]}` and refuses an
// unauthenticated caller with the gateway's error envelope, which always names
// a `type` and a `code`. Nothing else on this host answers in either shape,
// while a bare 401 is what every credential-guarded server on earth answers --
// so a status can confirm a stranger, and once did: on 2026-08-25 a 404 page
// was accepted here for the same reason, that the check read the status and
// never the answer.
async function answersAsRouter(answer) {
  let body;
  try {
    body = await answer.json();
  } catch {
    return false;
  }
  if (answer.status === 200) {
    return body?.object === 'list' && Array.isArray(body?.data);
  }
  const error = body?.error;
  return typeof error?.type === 'string' && typeof error?.code === 'string';
}

// Prefer the router that answers over the one a row remembers.
// A configuration row pointed at `http://100.120.25.24:8080` -- the gateway's
// tailnet address, which it does not bind, because it listens on loopback and is
// reached through stable local adapters. The runner failed with `fetch failed`
// and no address for a day. A declaration that the world contradicts is worth
// exactly what the world says, so this checks and substitutes the loopback of
// the same port when the configured host refuses.
export async function reachableRouterUrl(configured) {
  const candidates = [configured];
  try {
    const url = new URL(configured);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      candidates.push(`${url.protocol}//127.0.0.1:${url.port || '8080'}`);
    }
  } catch {
    // An unparseable address is left exactly as configured.
  }
  // Brama binds loopback; the canonical listener is the last resort behind
  // every stale row and proxy alias.
  candidates.push('http://127.0.0.1:8080');
  for (const candidate of [...new Set(candidates)]) {
    try {
      // Probe a route only the model router answers. `/health` is not one: a
      // stale address can now belong to anyone's site, and on 2026-08-25 it
      // did — the row's host returned a 404 page for /health, this helper
      // accepted it, and the runner died one request later with
      // `list subscriptions -> 404` against a server that never was Brama.
      // The catalogue refuses an unsigned caller with 401 and serves a
      // signed one with 200; both answers carry the router's identity.
      const answer = await fetch(`${candidate}/v1/models`, {
        signal: AbortSignal.timeout(Number('4000')),
      });
      const acceptable = answer.status === 401 || answer.status === 200;
      if (acceptable && await answersAsRouter(answer)) {
        if (candidate !== configured) {
          console.error(`router ${configured} refused; using ${candidate}`);
        }
        return candidate;
      }
      console.error(
        acceptable
          ? `router ${candidate} answered /v1/models ${answer.status} in a shape the model `
            + 'router never sends'
          : `router ${candidate} answered /v1/models ${answer.status}; not the model router`,
      );
    } catch (error) {
      console.error(`router ${candidate} unreachable: ${error.cause?.code ?? error.message}`);
    }
  }
  return configured;
}

// The client token lives beside every other credential on this fleet, under
// `<client>-model-router`, so read it from there when the environment is silent.
export function resolveBearer(agentId) {
  const fromEnv = process.env.WISENT_APP_MODEL_ROUTER_TOKEN;
  if (fromEnv) return fromEnv;
  const item = `${agentId}-model-router`;
  try {
    // `get` answers with the whole item document; `--field` is not a selector it
    // honours, and passing the document straight through as a header value is
    // how a bearer ended up printed in a log.
    const document = JSON.parse(skarbiec(['get', item]));
    const fields = document?.fields ?? {};
    const token = fields.token ?? fields.value;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch (error) {
    console.error(`no bearer: ${item} unreadable (${error.message.split('\n')[0]})`);
    return null;
  }
}