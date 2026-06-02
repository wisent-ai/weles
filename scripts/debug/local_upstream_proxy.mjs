import net from 'node:net';
import { Buffer } from 'node:buffer';

const listenHost = process.env.LOCAL_PROXY_HOST || '127.0.0.1';
const listenPort = Number(process.env.LOCAL_PROXY_PORT || 18081);
const upstreamHost = process.env.UPSTREAM_PROXY_HOST || process.env.DECODO_ISP_HOST || '185.111.111.44';
const upstreamPort = Number(process.env.UPSTREAM_PROXY_PORT || process.env.DECODO_ISP_PORT || 10002);
const upstreamUser = process.env.DECODO_ISP_USERNAME || '';
const upstreamPass = process.env.DECODO_ISP_PASSWORD || '';

if (!upstreamUser || !upstreamPass) throw new Error('DECODO_ISP_USERNAME/DECODO_ISP_PASSWORD missing');

const auth = Buffer.from(`${upstreamUser}:${upstreamPass}`).toString('base64');

function writeError(socket, code, text) {
  try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch {}
}

const server = net.createServer((client) => {
  let buffered = Buffer.alloc(0);
  let connected = false;
  let upstream;

  client.on('data', (chunk) => {
    if (connected) {
      upstream?.write(chunk);
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;

    const head = buffered.slice(0, headerEnd).toString('latin1');
    const rest = buffered.slice(headerEnd + 4);
    const first = head.split('\r\n')[0] || '';
    const m = /^CONNECT\s+([^ ]+)\s+HTTP\/1\.[01]$/i.exec(first);
    if (!m) {
      writeError(client, 405, 'CONNECT only');
      return;
    }

    upstream = net.connect({ host: upstreamHost, port: upstreamPort }, () => {
      upstream.write(`CONNECT ${m[1]} HTTP/1.1\r\nHost: ${m[1]}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });

    let upstreamHead = Buffer.alloc(0);
    upstream.on('data', (uChunk) => {
      if (connected) {
        client.write(uChunk);
        return;
      }
      upstreamHead = Buffer.concat([upstreamHead, uChunk]);
      const idx = upstreamHead.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const statusLine = upstreamHead.slice(0, idx).toString('latin1').split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
        client.end(`${statusLine || 'HTTP/1.1 502 Bad Gateway'}\r\nConnection: close\r\n\r\n`);
        upstream.destroy();
        return;
      }
      connected = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const upstreamRest = upstreamHead.slice(idx + 4);
      if (upstreamRest.length) client.write(upstreamRest);
      if (rest.length) upstream.write(rest);
    });

    upstream.on('error', () => writeError(client, 502, 'Bad Gateway'));
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream?.destroy());
  });

  client.on('error', () => upstream?.destroy());
});

server.listen(listenPort, listenHost, () => {
  console.log(`[local-upstream-proxy] listening http://${listenHost}:${listenPort} -> ${upstreamHost}:${upstreamPort}`);
});
