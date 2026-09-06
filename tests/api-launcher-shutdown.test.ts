import { test } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// launchd replaces the Weles API job with `launchctl kickstart -k`, which
// signals the job and starts its successor straight away. The API server used
// to be an unsupervised child of launch-weles-api-mac.sh, so the job's own
// process was the shell while the listening socket belonged to the server: the
// signal ended the shell and left the server orphaned still holding 8788. On
// charless-mac-mini that showed up as a unit log made entirely of
// `listen EADDRINUSE: address already in use 0.0.0.0:8788`, a port whose holder
// pid was not the job's pid, and three consecutive releases (0.5.57, 0.5.59,
// 0.5.60) rolled back for failed readiness against a port the predecessor still
// owned. The contract this defends: when the job is signalled, nothing it
// started keeps the port.
// The runner's cwd is the repository root; `import.meta` would force this file
// to load as ESM, which tap's loader cannot require.
const repoRoot = process.cwd();

// Whether anything is accepting connections on the port right now.
function portState(port: number, timeoutMs = 500): Promise<'open' | 'closed'> {
  const { promise, resolve } = Promise.withResolvers<'open' | 'closed'>();
  const socket = connect({ host: '127.0.0.1', port });
  const finish = (state: 'open' | 'closed') => {
    socket.destroy();
    resolve(state);
  };
  socket.setTimeout(timeoutMs);
  socket.once('connect', () => finish('open'));
  socket.once('timeout', () => finish('closed'));
  socket.once('error', () => finish('closed'));
  return promise;
}

// Real time is unavoidable here and fake timers cannot help: the awaited
// condition is a socket owned by a real launchd-style process tree in another
// process, so there is no in-process clock to advance. This polls the actual
// condition rather than sleeping for a guessed duration, and reports which
// condition it was still waiting for when it gave up.
function tick(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function waitForPort(port: number, want: 'open' | 'closed', seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if ((await portState(port)) === want) return true;
    if (Date.now() >= deadline) return false;
    await tick(100);
  }
}

// The unix socket the launcher makes the capability broker bind is
// `$HOME/.stado/run/weles-api-capability.sock`, and `sun_path` holds 104 bytes
// on this platform. A fixture under the repository's own `.work` puts that
// socket past the limit - the repository path alone is most of the budget -
// and the broker then fails to bind at all. So the fixture home lives on the
// short fleet scratch path instead, and the budget is asserted rather than
// assumed.
const SUN_PATH_LIMIT = 104;
const BROKER_SOCKET_SUFFIX = '/.stado/run/weles-api-capability.sock';

// A fixture tree that satisfies every path launch-weles-api-mac.sh reads, with
// the real script in its real place so its own `WELES_REPO` resolution lands
// inside the fixture. Nothing here is a credential: the stub acquisition helper
// prints a fixed placeholder.
function buildFixture(): { home: string; script: string; work: string } {
  const scratch = join(homedir(), '.stado/work/weles-tests');
  mkdirSync(scratch, { recursive: true });
  const work = mkdtempSync(join(scratch, 'al-'));
  const repo = join(work, 'repo');
  const home = join(work, 'h');
  const socket = `${home}${BROKER_SOCKET_SUFFIX}`;
  assert.ok(
    Buffer.byteLength(socket) < SUN_PATH_LIMIT,
    `the broker socket path is ${Buffer.byteLength(socket)} bytes, over the ${SUN_PATH_LIMIT}-byte unix socket limit: ${socket}`,
  );
  const deploy = join(repo, 'src/worker/deploy');
  mkdirSync(deploy, { recursive: true });
  mkdirSync(join(home, '.stado/bin'), { recursive: true });

  copyFileSync(
    join(repoRoot, 'src/worker/deploy/launch-weles-api-mac.sh'),
    join(deploy, 'launch-weles-api-mac.sh'),
  );
  writeFileSync(join(deploy, 'weles-action-allowlist.txt'), 'generic_capture\nkimi_reauth\n');
  writeFileSync(join(deploy, 'skarbiec-acquisition-scopes.conf'), '# stub\n');
  writeFileSync(join(deploy, 'weles-capability-routes.json'), '{}\n');
  writeFileSync(
    join(deploy, 'skarbiec-acquire.mjs'),
    'process.stdout.write("startup-field-placeholder");\n',
  );

  // Stands in for the API server: binds the port the launcher hands it and
  // stays up until it is signalled, which is what the real server does.
  writeFileSync(
    join(repo, 'src/worker/weles-api-server.mjs'),
    [
      'import { createServer } from "node:http";',
      'const server = createServer((_request, response) => response.end("ok"));',
      'server.listen(Number(process.env.WELES_API_PORT), process.env.WELES_API_HOST);',
      '// A listening server keeps the event loop alive on its own.',
    ].join('\n') + '\n',
  );

  const stadoStub = join(home, '.stado/bin/stado');
  writeFileSync(
    stadoStub,
    '#!/bin/bash\nprintf \'%s\\n\' \'{"resolved":{"agent_skarbiec_url":"http://127.0.0.1:1"}}\'\n',
  );
  chmodSync(stadoStub, 0o755);

  // The capability broker: a child that must also be reaped on shutdown. The
  // launcher waits for the socket to exist before starting the API server, so
  // the stub has to actually bind one rather than merely stay alive.
  const skarbiecStub = join(home, '.stado/bin/skarbiec');
  writeFileSync(
    skarbiecStub,
    [
      '#!/bin/bash',
      'socket=',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --socket) socket="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      `exec ${process.execPath} -e 'require("node:net").createServer().listen(process.argv[1])' "$socket"`,
    ].join('\n') + '\n',
  );
  chmodSync(skarbiecStub, 0o755);

  return { home, script: join(deploy, 'launch-weles-api-mac.sh'), work };
}

test('a signalled API job releases its port instead of orphaning the server', async () => {
  const port = 18788 + (process.pid % 900);
  const { home, script, work } = buildFixture();
  assert.equal(
    await portState(port),
    'closed',
    `port ${port} was already in use before the test started`,
  );
  // The launcher's own environment, minus the test runner's loader hooks:
  // tap injects `NODE_OPTIONS`, and every `node` the launcher starts - the
  // broker stub and the API server - would inherit that instrumentation and
  // run its entry point under it, which made the broker stub bind its socket
  // twice and fail with EADDRINUSE before the API server was ever reached.
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  const child = spawn('bash', [script], {
    cwd: repoRoot,
    env: {
      ...childEnv,
      HOME: home,
      NODE_BIN: process.execPath,
      WELES_API_HOST: '127.0.0.1',
      WELES_API_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exit = Promise.withResolvers<number | null>();
  child.once('exit', (code) => exit.resolve(code));

  try {
    assert.ok(
      await waitForPort(port, 'open', 30),
      `the launcher never bound 127.0.0.1:${port}; stderr:\n${stderr}`,
    );
    child.kill('SIGTERM');
    assert.ok(
      await waitForPort(port, 'closed', 20),
      `the launcher was signalled but 127.0.0.1:${port} is still held, so the server was orphaned; stderr:\n${stderr}`,
    );
    await exit.promise;
  } finally {
    child.kill('SIGKILL');
    execFileSync('rm', ['-rf', work]);
  }
});
