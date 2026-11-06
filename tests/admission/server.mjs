// The real Weles API server (src/worker/weles-api-server.mjs) started for a
// test: on a free loopback port, with its HOME, recordings, Stado-published
// placement documents and receipt keys under the test's own directory, and
// the release identity the release launcher would export. Nothing here
// stands in for the server: the test talks HTTP to the process the launcher
// runs.
//
// The server reads release/source-identity.json, which the release build
// writes; in a checkout or an export that has none, it is written from the
// checkout's commit for the test and removed when the server stops.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const IDENTITY = join(root, 'release', 'source-identity.json');

/**
 * The commit this tree is: the one `git archive` substituted into
 * release/source-commit in an export (an export may sit inside another
 * checkout, whose HEAD is not this tree), otherwise the checkout's HEAD.
 */
export function sourceRevision() {
  const carried = readFileSync(
    join(root, 'release', 'source-commit'),
    'utf8',
  ).trim();
  if (/^[0-9a-f]{40}$/.test(carried)) return carried;
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  assert.equal(
    git.status,
    0,
    `this tree is neither a git archive export nor a checkout: ${git.stderr}`,
  );
  return git.stdout.trim();
}

/**
 * The evidence of one test file: build/real-tests/<area>/<uuid>/report.json,
 * naming the commit, the command, every exchange and every case. `finish`
 * writes it and prints its path.
 */
export function evidenceFor(area) {
  const directory = join(root, 'build', 'real-tests', area, randomUUID());
  mkdirSync(directory, { recursive: true });
  const report = {
    source_revision: sourceRevision(),
    command: [process.execPath, ...process.argv.slice(1)],
    started_at: new Date().toISOString(),
    operations: [],
    cases: [],
  };
  return {
    directory,
    report,
    finish() {
      report.finished_at = new Date().toISOString();
      const path = join(directory, 'report.json');
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`report: ${path}`);
    },
  };
}

export const version = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).version;

/** A port nothing listens on now: the kernel's free one, released. */
export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const sha256Text = (text) =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/**
 * A sandbox: HOME, recordings, keys and the documents Stado publishes on a
 * host. With `from`, the new sandbox admits the same caller (bearer,
 * organization, keys) on its own state.
 */
export function sandbox(directory, from = undefined) {
  const home = join(directory, 'home');
  const recordings = join(directory, 'recordings');
  const published = join(directory, 'published');
  for (const path of [home, recordings, published])
    mkdirSync(path, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = 'receipt-key';
  const secrets = from ?? {
    bearer: randomUUID(),
    apiToken: randomUUID(),
    organizationId: randomUUID(),
    origin: 'https://example.com',
    keyId,
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKeys: JSON.stringify({
      [keyId]: publicKey.export({ format: 'pem', type: 'spki' }),
    }),
  };
  return {
    directory,
    home,
    recordings,
    published,
    bearer: secrets.bearer,
    apiToken: secrets.apiToken,
    organizationId: secrets.organizationId,
    origin: secrets.origin,
    keyId: secrets.keyId,
    privateKey: secrets.privateKey,
    publicKeys: secrets.publicKeys,
    policyFile: join(published, 'placement-policy.json'),
    directoryFile: join(published, 'weles-admission.directory.json'),
    endpointFile: join(published, 'weles-admission.local'),
    taskRoot: join(home, '.stado', 'weles-detached-runs', 'public-tasks'),
    runResults: join(home, '.stado', 'weles-detached-runs'),
  };
}

/** Publish the documents Stado writes for this host as the one public Weles host. */
export function publish(box, port, revision) {
  const endpoint = `http://127.0.0.1:${port}/api/v1`;
  const host = 'test-host';
  writeFileSync(
    box.policyFile,
    JSON.stringify({
      schema_version: 1,
      _source: {
        registry_generation: 7,
        by: 'stado host publish-placement-policy',
      },
      hosts: [
        { hostname: host, enabled: true, actions: ['generic_browser_task'] },
      ],
    }),
  );
  writeFileSync(
    box.directoryFile,
    JSON.stringify({
      schema: 'weles.public-service-directory.v1',
      directory_generation: 7,
      service: {
        name: 'weles-admission',
        active_host: host,
        action: 'generic_browser_task',
        release_id: `weles-worker@${version}`,
        source_revision: revision,
        endpoint,
      },
    }),
  );
  writeFileSync(box.endpointFile, `${endpoint}\n`);
  return {
    name: 'weles-admission',
    consumer: 'spis',
    capability: 'browser-evidence',
    directory_generation: 7,
    host,
    endpoint,
    action: 'generic_browser_task',
    release_id: `weles-worker@${version}`,
    source_revision: revision,
  };
}

/** A Spis binding of one attempt, every key recomputed as Spis computes it. */
export function spisBinding(service, revision) {
  const runId = 'crawl-1';
  const catalog = 'catalog-1';
  const record = 'record-1';
  const sourceInput = 'a'.repeat(64);
  const attempt = 1;
  const catalogKey = sha256Text(`${revision}\0${runId}\0${catalog}`);
  const recordKey = sha256Text(`${catalogKey}\0${record}\0${sourceInput}`);
  const attemptId = `attempt-${attempt}-${sha256Text(`${recordKey}\0${attempt}\0${service.host}`).slice(0, 16)}`;
  const base = `stado://spis-crawls/${runId}/${catalog}/${record}/${recordKey}/attempts/${attempt}/${attemptId}`;
  return {
    schema: 'weles.spis-browser-evidence-binding.v1',
    run_id: runId,
    catalog,
    record,
    record_key: recordKey,
    attempt,
    attempt_id: attemptId,
    source_revision: revision,
    source_input_sha256: sourceInput,
    reference_sha256: 'b'.repeat(64),
    artifact_uri: `${base}/artifacts.tar.gz`,
    output_uri: `${base}/worker-output.log`,
    // A copy: a test that edits its binding's service edits only its own.
    service: { ...service },
  };
}

/**
 * Start the server with `extra` environment over the sandbox's. Resolves
 * once it listens; `stop()` ends it and returns everything it printed.
 */
export async function startServer(box, port, extra = {}) {
  const revision = sourceRevision();
  let wroteIdentity = false;
  if (!existsSync(IDENTITY)) {
    writeFileSync(
      IDENTITY,
      `${JSON.stringify({ schema: 'weles.source-identity.v1', product: 'weles-worker', version, source_revision: revision, source_identity_kind: 'git-commit' })}\n`,
    );
    wroteIdentity = true;
  }
  const environment = {
    PATH: process.env.PATH,
    HOME: box.home,
    WELES_RECORDINGS_ROOT: box.recordings,
    WELES_API_HOST: '127.0.0.1',
    WELES_API_PORT: String(port),
    WELES_API_TOKEN: box.apiToken,
    WELES_WORKER_RELEASE_VERSION: version,
    WELES_WORKER_RELEASE_SHA256: 'c'.repeat(64),
    WELES_PUBLIC_API_BEARER: box.bearer,
    WELES_PUBLIC_API_ORGANIZATION_ID: box.organizationId,
    WELES_PUBLIC_API_ALLOWED_ORIGINS: `${box.origin},https://localhost,https://nonexistent-host.invalid`,
    WELES_RECEIPT_KEY_ID: box.keyId,
    WELES_RECEIPT_KEY_SET_VERSION: 'receipt-keys',
    WELES_RECEIPT_PRIVATE_KEY: box.privateKey,
    WELES_RECEIPT_PUBLIC_KEYS_JSON: box.publicKeys,
    WELES_PLACEMENT_POLICY_FILE: box.policyFile,
    WELES_PUBLIC_SERVICE_DIRECTORY_FILE: box.directoryFile,
    WELES_ADMISSION_ENDPOINT_FILE: box.endpointFile,
    // The object store a retained task uploads to; a closed loopback port,
    // since no test here retains evidence.
    STADO_API_URL: `http://127.0.0.1:${port + 1}`,
    WELES_STADO_OBJECT_API_TOKEN: randomUUID(),
    ...extra,
  };
  for (const [name, value] of Object.entries(environment))
    if (value === undefined) delete environment[name];
  const child = spawn(
    process.execPath,
    [join(root, 'src', 'worker', 'weles-api-server.mjs')],
    { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    const listening = () => {
      if (output.includes(`listening http://127.0.0.1:${port}`)) {
        child.stdout.off('data', listening);
        resolve();
      }
    };
    child.stdout.on('data', listening);
    exited.then((status) =>
      reject(
        new Error(
          `the Weles API server exited ${status} before listening: ${output}`,
        ),
      ),
    );
  });
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill('SIGTERM');
      await exited;
      if (wroteIdentity) rmSync(IDENTITY, { force: true });
      return output;
    },
  };
}

/** One HTTP exchange, recorded: the status and the parsed JSON answer. */
export async function exchange(report, base, path, init = {}) {
  const response = await fetch(new URL(path, base), {
    redirect: 'error',
    ...init,
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Kept as the text it was.
  }
  report.operations.push({
    method: init.method ?? 'GET',
    path,
    request_headers: Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([name, value]) => [
        name,
        /authorization/i.test(name) ? '[bearer withheld]' : value,
      ]),
    ),
    http_status: response.status,
    body,
  });
  return { status: response.status, body };
}
