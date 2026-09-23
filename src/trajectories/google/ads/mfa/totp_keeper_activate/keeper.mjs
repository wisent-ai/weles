// The keeper session behind the activation: its socket and its actions. This
// module talks to a running keeper; it never starts one.
import net from 'node:net';
import { SOCK, socketReady } from './settings.mjs';

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

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
