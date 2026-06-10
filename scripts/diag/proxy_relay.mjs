// Generic localhost proxy relay: no-auth localhost:PORT -> authenticated upstream.
//
// Solves two problems with driving a browser through an authenticated proxy:
//   1. Chromium/Playwright can't authenticate a TLS (https) upstream proxy.
//   2. The weles custom Chromium build throws 407 on some in-browser-authed
//      requests. Routing through this no-auth localhost relay avoids both —
//      the relay injects Proxy-Authorization on the CONNECT to the upstream.
//
// Works for any HTTP(S) CONNECT proxy (NodeMaven, Evomi, MarsProxies, ...).
// CONNECT-only (HTTPS tunnels), which is all browser traffic needs.
//
// Config via env (NO credentials in source — keep them in the shell/.env):
//   PROXY_UPSTREAM   host:port of the upstream proxy   (required)
//   PROXY_CRED       user:pass for the upstream         (required)
//   PROXY_TLS        "1" if the upstream speaks TLS (e.g. Evomi :1001)
//   RELAY_PORT       local listen port (default 8899)
//
// Example:
//   PROXY_UPSTREAM=gate.nodemaven.com:8080 \
//   PROXY_CRED='user-country-us-sid-abc:pass' \
//   node scripts/diag/proxy_relay.mjs
//   # then launch the browser with --proxy-server=http://127.0.0.1:8899
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';

const upstream = process.env.PROXY_UPSTREAM;
const cred = process.env.PROXY_CRED;
if (!upstream || !cred) {
  console.error('PROXY_UPSTREAM (host:port) and PROXY_CRED (user:pass) env vars are required');
  process.exit(1);
}
const [UP_HOST, UP_PORT_RAW] = upstream.split(':');
const UP_PORT = Number(UP_PORT_RAW || 8080);
const USE_TLS = process.env.PROXY_TLS === '1';
const AUTH = 'Basic ' + Buffer.from(cred).toString('base64');
const LISTEN = Number(process.env.RELAY_PORT || 8899);

function openUpstream(onReady) {
  if (USE_TLS) {
    return tls.connect({ host: UP_HOST, port: UP_PORT, servername: UP_HOST, rejectUnauthorized: false }, onReady);
  }
  return net.connect(UP_PORT, UP_HOST, onReady);
}

const server = http.createServer((req, res) => { res.writeHead(405); res.end('CONNECT only'); });
server.on('connect', (req, client, head) => {
  const up = openUpstream(() => {
    up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${AUTH}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    if (head && head.length) up.write(head);
  });
  let established = false, buf = Buffer.alloc(0);
  up.on('data', d => {
    if (established) return;
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    if (/^HTTP\/1\.[01] 200/.test(buf.slice(0, i).toString())) {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.slice(i + 4);
      if (rest.length) client.write(rest);
      up.pipe(client); client.pipe(up);
    } else {
      try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
      up.end();
    }
  });
  up.on('error', () => { try { client.end(); } catch {} });
  client.on('error', () => { try { up.end(); } catch {} });
});
server.listen(LISTEN, '127.0.0.1', () =>
  console.log(`[proxy-relay] 127.0.0.1:${LISTEN} -> ${UP_HOST}:${UP_PORT}${USE_TLS ? ' (tls)' : ''} sid=${(cred.match(/sid-([0-9a-z]+)/) || [])[1] || 'n/a'}`));
