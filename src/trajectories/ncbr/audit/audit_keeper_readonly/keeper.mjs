// The keeper transport: one command per socket connection, and the navigation, evaluation
// and screenshot commands the audit is built from.
import net from 'node:net';
import { SOCK } from './settings.mjs';

export function send(cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK);
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      conn.destroy();
      reject(new Error(`keeper timeout for ${cmd.action}`));
    }, timeoutMs);
    conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0 || done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      const res = JSON.parse(buf.slice(0, nl));
      if (!res.ok) reject(new Error(`${cmd.action} failed: ${res.error}`));
      else resolve(res);
    });
    conn.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function nav(url) {
  const out = await send({ action: 'nav', url }, 180000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  return out;
}

export async function read(js) {
  return (await send({ action: 'eval', js }, 120000)).result;
}

export async function shot(label) {
  const s = await send({ action: 'screenshot' }, 120000);
  return { label, path: s.path };
}
