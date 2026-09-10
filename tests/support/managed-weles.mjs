// Tests talk to the real Weles service through Stado's managed forward.
// This module never starts a browser or substitutes a product component.
import assert from 'node:assert/strict';
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
  return { evidence, retain, request };
}
