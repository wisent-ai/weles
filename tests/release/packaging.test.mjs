/**
 * Run the actual worker startup with the published native dependency.
 * Stado supplies WISENT_INPUT_JEDEN_RUNTIME_DIR; local runs can supply its
 * archive through WELES_TEST_JEDEN_ARCHIVE. The fleet CLI is real.
 * Source identity, commands and observed refusals remain in .wisent-output.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stadoBinary } from '../../src/_shared/skarbiec-runtime.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const input = process.env.WISENT_INPUT_JEDEN_RUNTIME_DIR;
const archive = input ? null : process.env.WELES_TEST_JEDEN_ARCHIVE;
const workerPayload = process.env.WELES_TEST_WORKER_PAYLOAD;
const stado = stadoBinary();
assert.ok((input || archive) && existsSync(input || archive),
  'WISENT_INPUT_JEDEN_RUNTIME_DIR or WELES_TEST_JEDEN_ARCHIVE must name the real published native input');
const output = join(REPO, '.wisent-output', 'native-runtime-tests', randomUUID());
const scratch = join(output, 'scratch');
mkdirSync(scratch, { recursive: true });
const report = {
  source_revision: process.env.WISENT_SOURCE_COMMIT ?? null,
  source_patch: null,
  native_input_directory: input ? resolve(input) : null,
  native_archive: archive ? resolve(archive) : null,
  native_archive_sha256: archive ? createHash('sha256').update(readFileSync(archive)).digest('hex') : null,
  worker_payload: workerPayload ? resolve(workerPayload) : null,
  worker_payload_sha256: workerPayload ? createHash('sha256').update(readFileSync(workerPayload)).digest('hex') : null,
  native_binary_sha256: {},
  commands: [],
};
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  console.log(`Native runtime evidence: ${join(output, 'report.json')}`);
});

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: REPO, encoding: 'utf8', ...options });
  const index = report.commands.length;
  writeFileSync(join(output, `${index}.stdout`), result.stdout ?? '');
  writeFileSync(join(output, `${index}.stderr`), result.stderr ?? '');
  report.commands.push({
    program, args, cwd: options.cwd ?? REPO, exit_code: result.status,
    signal: result.signal, error: result.error?.message ?? null,
    stdout: `${index}.stdout`, stderr: `${index}.stderr`,
  });
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return result;
}

if (report.source_revision) {
  assert.match(report.source_revision, /^[0-9a-f]{40}$/, 'Stado must export the full source commit');
} else {
  const revision = command('git', ['rev-parse', 'HEAD']);
  assert.equal(revision.status, 0, revision.stderr);
  report.source_revision = revision.stdout.trim();
  const patch = command('git', ['diff', '--binary', 'HEAD']);
  assert.equal(patch.status, 0, patch.stderr);
  writeFileSync(join(output, 'source.patch'), patch.stdout);
  report.source_patch = 'source.patch';
}
const native = join(scratch, 'input');
mkdirSync(native);
if (archive) {
  const extracted = command('tar', ['-xzf', resolve(archive), '-C', native]);
  assert.equal(extracted.status, 0, extracted.stderr);
} else {
  mkdirSync(join(native, 'bin'));
  for (const name of ['jeden', 'jeden-sandbox-helper']) {
    copyFileSync(join(input, 'bin', name), join(native, 'bin', name));
  }
}
for (const name of ['jeden', 'jeden-sandbox-helper']) {
  report.native_binary_sha256[name] = createHash('sha256')
    .update(readFileSync(join(native, 'bin', name))).digest('hex');
  const version = command(join(native, 'bin', name), ['--version']);
  assert.equal(version.status, 0, `${name} is not a working native input: ${version.stderr}`);
}


function fixture(name, helper = true, input = native) {
  const root = join(scratch, name);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  for (const relative of ['src/worker/weles-api-launcher.mjs', 'src/_shared/skarbiec-runtime.mjs']) {
    const destination = join(root, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(REPO, relative), destination);
  }
  cpSync(join(REPO, 'src/worker/weles-api-launcher'),
    join(root, 'src/worker/weles-api-launcher'), { recursive: true });
  const bin = join(root, 'native', 'jeden', 'bin');
  const staged = command(process.execPath, [
    join(REPO, 'release/native/runtime.mjs'), 'stage', bin, input,
  ]);
  assert.equal(staged.status, 0, staged.stderr);
  if (!helper) rmSync(join(bin, 'jeden-sandbox-helper'));
  return { root, home, bin };
}

function startup({ root, home }) {
  return command(process.execPath, [join(root, 'src/worker/weles-api-launcher.mjs')], {
    cwd: home,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      NODE_BIN: process.execPath,
      STADO_BIN: resolve(stado),
      STADO_CONFIG: join(home, 'absent-stado-config.json'),
      WELES_API_PORT: '0',
      // A complete, real external runtime must not hide a broken bundle.
      WELES_JEDEN_BIN: join(native, 'bin', 'jeden'),
    },
  });
}

function noBroker(home) {
  const root = join(home, '.stado/run');
  const sockets = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isSocket() || entry.isDirectory()) : [];
  assert.deepEqual(sockets, [], 'a refused startup created capability broker state');
}

test('a missing bundled helper refuses despite a complete external Jeden', () => {
  const value = fixture('missing-helper', false);
  const result = startup(value);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(join(value.bin, 'jeden-sandbox-helper')), result.stderr);
  noBroker(value.home);
});

test('an executable but corrupt bundled helper refuses before credentials', () => {
  const value = fixture('corrupt-helper');
  truncateSync(join(value.bin, 'jeden-sandbox-helper'), 8);
  const result = startup(value);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(join(value.bin, 'jeden-sandbox-helper')), result.stderr);
  assert.doesNotMatch(result.stderr, /Skarbiec endpoint resolution/);
  noBroker(value.home);
});

test('the complete signed native pair reaches the real missing-directory refusal', () => {
  const value = fixture('complete', true, archive ?? native);
  const result = startup(value);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Skarbiec endpoint resolution refused/);
  noBroker(value.home);
});

test('an archive outside the declared digest is refused before staging bytes', () => {
  const wrong = join(scratch, 'wrong-native.tar.gz');
  const destination = join(scratch, 'untrusted', 'bin');
  copyFileSync(join(native, 'bin', 'jeden'), wrong);
  const result = command(process.execPath, [
    join(REPO, 'release/native/runtime.mjs'), 'stage', destination, wrong,
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SHA-256/);
  assert.equal(existsSync(destination), false, 'unverified input reached the staged runtime');
});

test('worker startup and repeated startup restore an incomplete cache without changing the installed release tree', {
  skip: !workerPayload && 'requires the real compiled WELES_TEST_WORKER_PAYLOAD',
}, () => {
  const root = join(scratch, 'immutable-release');
  const expected = join(scratch, 'expected-release');
  const home = join(scratch, 'release-owner');
  mkdirSync(join(root, 'payload'), { recursive: true });
  mkdirSync(home);
  copyFileSync(workerPayload, join(root, 'payload', 'weles-worker.tar.gz'));
  copyFileSync(join(REPO, 'release', 'stado-launcher.sh'), join(root, 'weles-api-launcher'));
  cpSync(root, expected, { recursive: true });
  const options = {
    cwd: home,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      NODE_BIN: process.execPath,
      STADO_BIN: resolve(stado),
      STADO_CONFIG: join(home, 'absent-stado-config.json'),
      WELES_API_PORT: '0',
    },
  };
  const configuration = join(home, '.stado/var/weles/runtime', report.worker_payload_sha256,
    'src/worker/weles-api-launcher/configuration.mjs');
  let originalConfiguration;
  for (const phase of ['initial startup', 'repeated startup']) {
    const result = command('bash', [join(root, 'weles-api-launcher')], options);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Skarbiec endpoint resolution refused/);
    noBroker(home);
    const difference = command('diff', ['-qr', expected, root]);
    assert.equal(difference.status, 0,
      `${phase} changed the installed release: ${difference.stdout}${difference.stderr}`);
    if (phase === 'initial startup') {
      originalConfiguration = readFileSync(configuration);
      rmSync(configuration);
    } else {
      assert.deepEqual(readFileSync(configuration), originalConfiguration,
        'a marked-ready runtime with a missing launcher module was not restored from the payload');
    }
  }
});

test('a healthy API refuses a second launcher without losing its listener', {
  skip: !workerPayload && 'requires the real compiled WELES_TEST_WORKER_PAYLOAD',
}, async () => {
  const root = join(scratch, 'existing-api');
  const home = join(scratch, 'api-owner');
  mkdirSync(root);
  mkdirSync(home);
  const unpacked = command('tar', ['-xzf', resolve(workerPayload), '-C', root]);
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const env = {
    HOME: home, PATH: process.env.PATH, NODE_BIN: process.execPath,
    STADO_BIN: resolve(stado), STADO_CONFIG: join(home, 'absent-stado-config.json'),
    WELES_API_HOST: '127.0.0.1', WELES_API_PORT: '0', WELES_API_TOKEN: randomUUID(),
    WELES_KEYWORD_PLANNER_API_TOKEN: randomUUID(),
    WELES_WORKER_RELEASE_VERSION: version,
    WELES_WORKER_RELEASE_SHA256: report.worker_payload_sha256,
  };
  const args = [join(root, 'src/worker/weles-api-server.mjs')];
  const api = spawn(process.execPath, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  api.stderr.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise(resolveClose => {
    api.once('close', (exit_code, signal) => resolveClose({ exit_code, signal }));
  });
  const ready = new Promise((resolveReady, reject) => {
    api.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.includes('[weles-api] listening ')) resolveReady();
    });
    api.once('error', reject);
    api.once('exit', code => reject(new Error(`real Weles API exited ${code}: ${stderr}`)));
  });
  try {
    await ready;
    const sockets = command(existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof',
      ['-nP', '-a', '-p', String(api.pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
    assert.equal(sockets.status, 0, sockets.stderr);
    const port = /^n127\.0\.0\.1:(\d+)$/m.exec(sockets.stdout)?.[1];
    assert.ok(port, `the real API process owns no loopback listener: ${sockets.stdout}`);
    const endpoint = `http://127.0.0.1:${port}/healthz`;
    const health = await fetch(endpoint);
    assert.equal(health.status, 200);
    const reported = await health.json();
    assert.equal(reported.sourceRevision, report.source_revision);
    // The keyword planner has no server of its own: the same process and port
    // answer its routes, behind the planner's own bearer.
    assert.ok(reported.routes.includes('POST /google-ads/keyword-volume'), JSON.stringify(reported.routes));
    assert.ok(reported.routes.includes('POST /google-ads/keyword-report'), JSON.stringify(reported.routes));
    for (const route of ['/google-ads/keyword-volume', '/google-ads/keyword-report']) {
      const planner = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.WELES_API_TOKEN}`, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(planner.status, 401, route);
      assert.equal((await planner.json()).error, 'unauthorized', route);
    }
    const workerHeaders = { authorization: `Bearer ${env.WELES_API_TOKEN}` };
    const refused = await fetch(`http://127.0.0.1:${port}/worker/restart`, { method: 'POST' });
    assert.equal(refused.status, 401);
    report.worker_control = [{ action: 'unauthenticated-restart', status: refused.status, body: await refused.json() }];
    const worker = await fetch(`http://127.0.0.1:${port}/worker/status`, { headers: workerHeaders });
    assert.equal(worker.status, 200);
    const workerBody = await worker.json();
    report.worker_control.push({ action: 'status', status: worker.status, body: workerBody });
    assert.equal(workerBody.worker.pid, api.pid);
    assert.equal(workerBody.worker.running, true);
    for (const action of ['start', 'restart']) {
      const response = await fetch(`http://127.0.0.1:${port}/worker/${action}`, { method: 'POST', headers: workerHeaders });
      const body = await response.json();
      report.worker_control.push({ action, status: response.status, body });
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.changed, action === 'restart');
      assert.equal(body.after.pid, api.pid);
      assert.equal(body.after.running, true);
    }
    const cli = command(process.execPath, [join(root, 'dist/cli.js'), 'worker', 'status', '--json'], {
      cwd: home, env: { ...env, WELES_WORKER_API_BASE: `http://127.0.0.1:${port}`, WELES_WORKER_TOKEN: env.WELES_API_TOKEN },
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).worker.pid, api.pid);
    const duplicate = command(process.execPath, [join(root, 'src/worker/weles-api-launcher.mjs')], {
      cwd: home, env: { ...env, WELES_API_PORT: port },
    });
    assert.equal(duplicate.status, 1, duplicate.stderr);
    assert.ok(duplicate.stderr.includes(`pid ${api.pid}`), duplicate.stderr);
    assert.ok(duplicate.stderr.includes(reported.source), duplicate.stderr);
    const stillServing = await fetch(endpoint);
    assert.equal(stillServing.status, 200);
    assert.equal((await stillServing.json()).sourceRevision, report.source_revision);
  } finally {
    if (api.exitCode === null) api.kill('SIGTERM');
    const result = await closed;
    const index = report.commands.length;
    writeFileSync(join(output, `${index}.stdout`), stdout);
    writeFileSync(join(output, `${index}.stderr`), stderr);
    report.commands.push({ program: process.execPath, args, cwd: home, pid: api.pid,
      ...result, stdout: `${index}.stdout`, stderr: `${index}.stderr` });
    writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
});
