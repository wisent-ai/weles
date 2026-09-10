// Real declared observation through Weles on the Stado-selected dedicated host.
// No local browser, generated trajectory, simulated page or replacement provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const forward = join(process.env.STADO_FORWARDS_DIR || join(homedir(), '.stado/forwards'), 'weles-admission.local');
const evidenceRoot = join(root, '.wisent-output/observation');
mkdirSync(evidenceRoot, { recursive: true });
const evidence = mkdtempSync(join(evidenceRoot, 'run-'));
const observation = 'github.profile_view';
const handle = 'wisent-ai';

function retain(name, value) {
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n');
}

function worker() {
  const endpoint = new URL(readFileSync(forward, 'utf8').trim());
  assert.ok(['http:', 'https:'].includes(endpoint.protocol));
  if (endpoint.protocol === 'http:') {
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'plaintext must stay on the Stado forward');
  }
  const stado = process.env.STADO_BIN || join(homedir(), '.stado/bin/stado');
  const token = spawnSync(stado, ['credentials', 'get', 'echo-weles-api', '--field', 'token'], { encoding: 'utf8' });
  assert.equal(token.status, 0, `cannot resolve the real Weles credential: ${token.stderr}`);
  assert.ok(token.stdout.trim(), 'Stado returned no Weles bearer');
  return { endpoint, headers: { authorization: `Bearer ${token.stdout.trim()}`, 'content-type': 'application/json' } };
}

async function request(client, name, path, document) {
  const options = { method: 'GET', headers: client.headers };
  if (document !== undefined) {
    options.method = 'POST';
    options.body = JSON.stringify(document);
  }
  const response = await fetch(new URL(path, client.endpoint), options);
  const body = await response.json();
  retain(`${name}.json`, { method: options.method, path, request: document, status: response.status, body });
  return { status: response.status, body };
}

test('declared observation reads the real page and leaves its own persisted evidence', async () => {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(revision.status, 0, revision.stderr);
  const client = worker();
  const identity = await request(client, 'worker-version', '/worker/version');
  assert.equal(identity.status, 200, JSON.stringify(identity.body));
  retain('source.json', { test_revision: revision.stdout.trim(), worker_identity: identity.body });

  const run = await request(client, 'observation', '/run', {
    action: 'generic_keeper_task', params: { observation, handle }, creds: 'redact',
  });
  if (run.body.run_id) {
    await request(client, 'diagnostics', `/diagnostics/${encodeURIComponent(run.body.run_id)}`);
  }
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  const runId = run.body.run_id;
  assert.equal(typeof runId, 'string');
  const manifest = await request(client, 'completed-diagnostics', `/diagnostics/${encodeURIComponent(runId)}`);
  assert.equal(manifest.status, 200, JSON.stringify(manifest.body));
  const signalFile = manifest.body.files.find((file) => file.path.endsWith('/ban_signal.json'));
  assert.ok(signalFile, 'the real browser trajectory did not persist an observation');
  const signal = await request(client, 'observed-state', signalFile.download_url);
  assert.equal(signal.status, 200);
  assert.equal(signal.body.observation, observation);
  assert.equal(signal.body.origin, `https://github.com/${handle}`);
  assert.equal(signal.body.reads, 'profile');
  assert.equal(signal.body.healthy, true, JSON.stringify(signal.body));

  const refused = await request(client, 'undeclared-observation', '/run', {
    action: 'generic_keeper_task', params: { observation: 'github.not-declared' }, creds: 'redact',
  });
  assert.notEqual(refused.body.ok, true, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /observation github\.not-declared is not declared/);
  const unchanged = await request(client, 'successful-state-after-refusal', signalFile.download_url);
  assert.deepEqual(unchanged.body, signal.body, 'a refused run changed the successful observation');
  console.error(`real observation evidence: ${evidence}`);
});
