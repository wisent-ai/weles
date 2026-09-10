// The keeper process behind the activation: its socket, its actions, and its start.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AUTHENTICATOR_URL, DIAG_DIR, KEEPER, REPO, SESSION, SOCK, USER_DATA_DIR, scopedChildEnvironment, socketReady } from './settings.mjs';

export function action(cmd, timeoutMs = 60_000) {
  return new Promise((resolvePromise, reject) => {
    const conn = net.createConnection(SOCK);
    let done = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { conn.destroy(); } catch {}
      reject(new Error(`keeper action timeout: ${cmd.action}`));
    }, timeoutMs);
    conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      try {
        const parsed = JSON.parse(buf.slice(0, nl));
        if (!parsed.ok) reject(new Error(parsed.error || `keeper action failed: ${cmd.action}`));
        else resolvePromise(parsed);
      } catch (error) {
        reject(error);
      }
    });
    conn.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function waitForKeeper(ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (socketReady()) {
      try { await action({ action: 'url' }, 5_000); return true; } catch {}
    }
    await sleep(500);
  }
  return false;
}

export function startKeeperIfNeeded() {
  if (socketReady()) return false;
  if (process.env.GOOGLE_ADS_KEEPER_START === '0') return false;
  mkdirSync(dirname(SOCK), { recursive: true });
  const logPath = join(DIAG_DIR, `keeper-${SESSION}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [KEEPER], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: scopedChildEnvironment({
      SESSION,
      KEEPER_FLOW_ACTION: 'google_ads_totp_keeper',
      KEEPER_USER_DATA_DIR: USER_DATA_DIR,
      WELES_USER_DATA_DIR: USER_DATA_DIR,
      KEEPER_STAY_ALIVE_ON_SIGTERM: '1',
      KEEPER_DISABLE_WEBAUTHN: '1',
      WELES_DISABLE_RECORDING: process.env.WELES_DISABLE_RECORDING || '1',
      WELES_NO_INSTRUMENT: process.env.WELES_NO_INSTRUMENT || '1',
      GOOGLE_SSO_NO_SCREENSHOTS: '1',
      URL: AUTHENTICATOR_URL,
    }),
  });
  child.unref();
  return true;
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
