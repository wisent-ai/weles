// Simple HTTP forward proxy bound to a specific network interface (iPhone USB tethering)
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';

process.on('uncaughtException', (e) => { console.error(`[proxy] uncaught: ${e.message}`); });
process.on('unhandledRejection', (e) => { console.error(`[proxy] unhandled: ${e}`); });

const IFACE = process.argv[2] || 'en7';
const PORT = parseInt(process.argv[3] || '9001', 10);

const addrs = networkInterfaces()[IFACE];
if (!addrs) { console.error(`Interface ${IFACE} not found`); process.exit(1); }
const localIp = addrs.find(a => a.family === 'IPv4')?.address;
if (!localIp) { console.error(`No IPv4 on ${IFACE}`); process.exit(1); }
console.log(`[proxy] Binding to ${IFACE} (${localIp}), listening on port ${PORT}`);

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url);
    const opts = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers: req.headers,
      localAddress: localIp,
    };
    const proxy = http.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxy.on('error', (e) => { try { res.writeHead(502); res.end(`Proxy error: ${e.message}`); } catch {} });
    req.on('error', () => {});
    req.pipe(proxy);
  } catch (e) { try { res.writeHead(502); res.end('error'); } catch {} }
});

server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  clientSocket.on('error', () => {});
  const serverSocket = net.connect({ host, port: parseInt(port, 10), localAddress: localIp }, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on('error', () => { try { clientSocket.end(); } catch {} });
});

server.on('error', (e) => { console.error(`[proxy] server error: ${e.message}`); });

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] HTTP/HTTPS proxy running on 127.0.0.1:${PORT} → ${IFACE} (${localIp})`);
});
