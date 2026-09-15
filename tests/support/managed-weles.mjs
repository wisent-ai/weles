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
    return { exit_code: result.status, body: JSON.parse(result.stdout) };
  }
  return { evidence, retain, request, download, runBrowserPlan };
}
