import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await evidenceFor('worker-status-diagnostics');
evidence.report.scope = 'read_only_worker_status';
evidence.report.node_version = process.version;
evidence.report.browser_flow = 'not_run';
evidence.report.control_mutations = 'not_run';

async function executable() {
  const name = process.env.WELES_BIN || 'weles';
  const candidates = isAbsolute(name) || name.includes(sep)
    ? [resolve(name)]
    : (process.env.PATH || '').split(delimiter).map(directory => resolve(directory || '.', name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
    }
  }
  throw new Error(`WELES_CLI_UNAVAILABLE: ${name}`);
}

function observe(cli, name, overrides = {}) {
  const result = spawnSync(process.execPath, [cli, 'worker', 'status', '--json'], {
    cwd: root, env: { ...process.env, ...overrides }, encoding: 'utf8',
  });
  const operation = {
    name, command: [process.execPath, cli, 'worker', 'status', '--json'], cwd: root,
    environment_overrides: overrides, exit_status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null,
  };
  evidence.report.operations.push(operation);
  return { operation, result };
}

function answer(observation) {
  const { operation, result } = observation;
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, 'the CLI must return its own result');
  const value = JSON.parse(result.stdout);
  operation.answer = value;
  assert.equal(value.operation, 'status');
  assert.ok(Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599,
    'the result must identify the observed HTTP status');
  assert.equal(new URL(value.endpoint).pathname, '/worker/status');
  assert.equal(typeof value.ok, 'boolean');
  assert.equal(result.status, value.ok && value.http_status < 400 ? 0 : 1);
  return value;
}

try {
  const cli = await executable();
  const packageRoot = dirname(dirname(cli));
  const identity = { executable: cli, source_revision: null, source_marker: null, files_sha256: {} };
  evidence.report.cli = identity;
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'weles', 'WELES_BIN must name the installed Weles Node CLI');
  identity.version = manifest.version;
  for (const relative of ['dist/cli.js', 'dist/cli/worker/index.js', 'dist/runtime/api/connection.js']) {
    identity.files_sha256[relative] = createHash('sha256').update(await readFile(join(packageRoot, relative))).digest('hex');
  }
  try {
    identity.source_marker = (await readFile(join(packageRoot, 'release/source-commit'), 'utf8')).trim();
    if (/^[a-f0-9]{40}$/.test(identity.source_marker)) identity.source_revision = identity.source_marker;
  } catch (error) {
    identity.source_marker_error = error.message;
  }

  // A status read remains useful evidence even when an old package cannot be
  // qualified. It never starts a browser or sends a worker control request.
  const version = { interface: 'installed_runtime', method: 'GET', path: '/worker/version' };
  evidence.report.operations.push(version);
  try {
    const api = await import(pathToFileURL(join(packageRoot, 'dist/runtime/api/connection.js')).href);
    const connection = api.welesOperatorConnection(version.path);
    version.endpoint = connection.endpoint.toString();
    const response = await connection.fetch(connection.endpoint, {
      method: version.method, headers: connection.headers, redirect: 'error',
    });
    version.http_status = response.status;
    version.body = await api.operatorJson(response);
    version.status = response.ok ? 'observed' : 'refusal_observed';
  } catch (error) {
    version.status = 'unavailable';
    version.failure = { message: String(error), stack: error?.stack, cause: String(error?.cause ?? '') };
  }
  const configured = observe(cli, 'configured_status');
  if (identity.source_revision !== evidence.report.source_revision) {
    evidence.report.status = 'blocked';
    evidence.report.reason = identity.source_revision
      ? `WELES_CLI_REVISION_NOT_INSTALLED: expected ${evidence.report.source_revision}; observed ${identity.source_revision}`
      : 'WELES_CLI_REVISION_UNAVAILABLE: the installed package has no full source revision';
    evidence.report.qualified_cases = 0;
    process.exitCode = 1;
  } else {
    const value = answer(configured);
    if (value.error === 'worker_contract_invalid') {
      assert.equal(value.ok, false);
      assert.equal(typeof value.message, 'string');
      assert.ok(Object.hasOwn(value, 'observed_response'), 'a protocol refusal must retain the received document');
      configured.operation.status = 'refusal_observed';
    } else {
      assert.equal(value.ok, true, `the configured status read was refused: ${configured.result.stdout}`);
      assert.equal(value.worker.schema, 'weles.worker-status.v1');
      assert.ok(Number.isSafeInteger(value.worker.pid) && value.worker.pid > 0);
      configured.operation.status = 'resident_status_observed';
    }
    const unauthorized = observe(cli, 'unauthorized_status', { WELES_WORKER_TOKEN: `invalid-${randomUUID()}` });
    const refusal = answer(unauthorized);
    assert.equal(refusal.http_status, 401, 'the real worker must reject the invalid bearer');
    assert.equal(refusal.ok, false);
    unauthorized.operation.status = 'passed';
    evidence.report.status = 'passed';
    evidence.report.qualified_cases = 2;
  }
} catch (error) {
  evidence.report.status = 'failed';
  evidence.report.failure = error.message;
  process.exitCode = 1;
} finally {
  await evidence.finish();
}
