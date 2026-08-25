#!/usr/bin/env node
// Start the synchronous HTTP API (scripts/worker/weles-api-server.mjs) on a
// random localhost port, hit /healthz, show that an authenticated route
// refuses a caller without the bearer token, then shut the server down.
// No trajectory is run and nothing leaves localhost.
//
// Usage: node docs/examples/api-server-smoke.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TOKEN = 'docs-example-token';

// Ask the OS for a free port, then hand it to the server via WELES_API_PORT.
const port = await new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});

const server = spawn(process.execPath, [`${repo}/scripts/worker/weles-api-server.mjs`], {
  cwd: repo,
  env: { ...process.env, WELES_API_TOKEN: TOKEN, WELES_API_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'inherit'],
});

try {
  // The server prints one line when it is accepting connections.
  await new Promise((done, fail) => {
    let banner = '';
    const timer = setTimeout(() => fail(new Error('server did not start within 10s')), 10_000);
    server.stdout.on('data', (chunk) => {
      banner += chunk;
      if (banner.includes('[weles-api] listening')) {
        clearTimeout(timer);
        console.log(banner.trim());
        done();
      }
    });
    server.once('exit', (code) => fail(new Error(`server exited early with code ${code}`)));
  });

  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/healthz`);
  const healthBody = await health.json();
  console.log(`\nGET /healthz -> ${health.status}`);
  console.log(JSON.stringify({ ...healthBody, login_items: `[${healthBody.login_items.length} entries]` }, null, 2));

  const noAuth = await fetch(`${base}/worker/version`);
  console.log(`\nGET /worker/version without token -> ${noAuth.status}`, await noAuth.text());
} finally {
  server.kill('SIGTERM');
}
