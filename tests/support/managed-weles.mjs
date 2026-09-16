// Tests talk to the real Weles service through Stado's managed forward.
// This module never starts a browser or substitutes a product component.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export function managedWeles(area) {
  const evidenceRoot = join(root, '.wisent-output', area);
  mkdirSync(evidenceRoot, { recursive: true });
  const evidence = mkdtempSync(join(evidenceRoot, 'run-'));
  const retain = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n');
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(revision.status, 0, revision.stderr);
  const forward = join(process.env.STADO_FORWARDS_DIR || join(homedir(), '.stado/forwards'), 'weles-admission.local');
  const endpoint = new URL(readFileSync(forward, 'utf8').trim());
  assert.ok(['http:', 'https:'].includes(endpoint.protocol));
  if (endpoint.protocol === 'http:') assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
  const stado = process.env.STADO_BIN || join(homedir(), '.stado/bin/stado');
  const credential = spawnSync(stado, ['credentials', 'get', 'echo-weles-api', '--field', 'token'], { encoding: 'utf8' });
  retain('credential-read.json', { exit_code: credential.status, stderr: credential.stderr });
  assert.equal(credential.status, 0, credential.stderr);
  assert.ok(credential.stdout.trim(), 'Stado returned no Weles bearer');
  const headers = { authorization: `Bearer ${credential.stdout.trim()}`, 'content-type': 'application/json' };
  retain('source.json', { test_revision: revision.stdout.trim(), forward, endpoint: endpoint.href });
  async function request(name, path, document) {
    const options = { method: 'GET', headers };
    if (document !== undefined) {
      options.method = 'POST';
      options.body = JSON.stringify(document);
    }
    const response = await fetch(new URL(path, endpoint), options);
    const body = await response.json();
    retain(`${name}.json`, { method: options.method, path, request: document, status: response.status, body });
    return { status: response.status, body };
  }
  async function download(name, path) {
    const url = new URL(path, endpoint);
    assert.equal(url.origin, endpoint.origin, 'diagnostic artifacts must remain on the managed Weles endpoint');
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200, `artifact ${path}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(join(evidence, name), bytes);
    retain(`${name}.json`, {
      path, status: response.status, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  function runBrowserPlan(name, plan) {
    const path = join(evidence, `${name}-plan.json`);
    retain(`${name}-plan.json`, plan);
    const argv = ['workload', 'run', 'weles-browser-task', '--plan', path, '--json'];
    console.error(`real browser plan: ${path}`);
    const result = spawnSync(stado, argv, { encoding: 'utf8' });
    retain(`${name}-command.json`, {
      executable: stado, argv, exit_code: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
    });
    assert.ifError(result.error);
    assert.ok(result.stdout.trim(),
      `stado workload run returned no JSON (exit ${result.status}, signal ${result.signal ?? 'none'}): ${result.stderr}`);
    return { exit_code: result.status, body: JSON.parse(result.stdout) };
  }
  async function captureBrowserRun(run, label) {
    assert.equal(typeof run.body.run_id, 'string', JSON.stringify(run.body));
    const manifest = await request('artifact-inventory', `/diagnostics/${encodeURIComponent(run.body.run_id)}`);
    assert.equal(manifest.status, 200, JSON.stringify(manifest.body));
    const files = manifest.body.files;
    const taskFile = files.find(file => file.path.endsWith('/generic_task_result.json'));
    const runtimeFile = files.find(file => file.path === 'run-result.json');
    assert.ok(taskFile, 'the browser did not retain its final state');
    assert.ok(runtimeFile, 'the worker did not retain its exact runtime revision');
    const task = await request('browser-state', taskFile.download_url);
    const runtime = await request('runtime-source', runtimeFile.download_url);
    const recording = files.find(file => file.path.startsWith(`${label}/`) && file.path.endsWith('.webm'));
    const screenshot = files.filter(file => file.path.startsWith(`${label}/`) && file.path.endsWith('.png'))
      .sort((left, right) => left.modified_at.localeCompare(right.modified_at)).at(-1);
    assert.ok(recording, 'the real browser recording is missing');
    assert.ok(screenshot, 'the final rendered browser state is missing');
    await download('journey.webm', recording.download_url);
    await download('final-page.png', screenshot.download_url);
    assert.equal(task.status, 200);
    assert.equal(runtime.status, 200);
    if (process.env.WELES_REAL_EXPECTED_REVISION) {
      assert.equal(runtime.body.source_revision, process.env.WELES_REAL_EXPECTED_REVISION);
    }
    assert.equal(run.body.ok, true, JSON.stringify(run.body));
    assert.equal(run.exit_code, 0);
    assert.equal(task.body.ok, true, JSON.stringify(task.body));
    return task.body;
  }
  return { evidence, retain, request, download, runBrowserPlan, captureBrowserRun };
}
