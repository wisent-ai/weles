/**
 * The version gate, through the real `weles release` command.
 *
 * This is the check `version-check` runs on every push: AutoVersion's decision,
 * the released baseline, the repository's own version declaration and the
 * package manifest must all say the same thing, and a declaration that lies
 * about the candidate must be refused. The workflow proves the second half by
 * feeding the gate a deliberately false declaration, so the refusal is part of
 * the contract and is measured here against the repository's real documents.
 *
 * Run: node --test tests/release/version-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const CLI = join(REPO, 'dist/cli.js');
const declarationPath = join(REPO, 'release/version-change.json');
const declaration = JSON.parse(readFileSync(declarationPath, 'utf8'));
const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));

function documents(overrides = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'weles-version-gate-'));
  const decision = {
    current: declaration.current,
    change: 'additive',
    next: declaration.candidate,
    added: ['cmd:weles release'],
    removed: [],
    ...(overrides.decision ?? {}),
  };
  const baseline = { version: declaration.current, surface: [], ...(overrides.baseline ?? {}) };
  const declared = { ...declaration, ...(overrides.declaration ?? {}) };
  const paths = {
    decision: join(workspace, 'decision.json'),
    baseline: join(workspace, 'baseline.json'),
    declaration: join(workspace, 'declaration.json'),
    manifest: join(workspace, 'package.json'),
  };
  writeFileSync(paths.decision, JSON.stringify(decision));
  writeFileSync(paths.baseline, JSON.stringify(baseline));
  writeFileSync(paths.declaration, JSON.stringify(declared));
  writeFileSync(paths.manifest, JSON.stringify({ ...manifest, ...(overrides.manifest ?? {}) }));
  return paths;
}

function enforce(paths) {
  return spawnSync(process.execPath, [
    CLI, 'release', 'enforce-version',
    '--decision', paths.decision,
    '--baseline', paths.baseline,
    '--declaration', paths.declaration,
    '--manifest', paths.manifest,
  ], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
}

test('the gate accepts the repository’s own declaration and reports the verdict', () => {
  const result = enforce(documents());
  assert.equal(result.status, 0, `gate refused a true declaration: ${result.stderr}`);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.schema, 'weles.version-verdict.v1');
  assert.equal(verdict.released, declaration.current);
  assert.equal(verdict.declared, declaration.candidate);
  assert.equal(verdict.required, declaration.candidate);
});

test('the gate refuses a declaration whose candidate AutoVersion did not require', () => {
  const result = enforce(documents({ declaration: { candidate: '9.9.9' }, manifest: { version: '9.9.9' } }));
  assert.equal(result.status, 1, 'a false candidate was accepted');
  assert.equal(
    result.stderr.trim(),
    `weles: package declares 9.9.9, but AutoVersion requires ${declaration.candidate}`,
  );
});

test('the gate refuses a package version that disagrees with the declaration', () => {
  const result = enforce(documents({ manifest: { version: '0.0.1' } }));
  assert.equal(result.status, 1, 'a mismatched package version was accepted');
  assert.equal(
    result.stderr.trim(),
    `weles: package version 0.0.1 does not match declaration candidate ${declaration.candidate}`,
  );
});

test('the gate refuses a declared breaking change AutoVersion did not escalate', () => {
  const result = enforce(documents({ declaration: { breaking: true } }));
  assert.equal(result.status, 1, 'an unescalated breaking change was accepted');
  assert.equal(result.stderr.trim(), 'weles: declared breaking change was not escalated by AutoVersion');
});

test('the surface command reports the commands, routes and schemas this build publishes', () => {
  const result = spawnSync(process.execPath, [CLI, 'release', 'surface'],
    { cwd: REPO, encoding: 'utf8', timeout: 300_000 });
  assert.equal(result.status, 0, `surface failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, declaration.current);
  assert.ok(report.surface.includes('cmd:weles release'), 'the release command is missing from the surface');
  assert.ok(report.surface.some((entry) => entry.startsWith('http:GET /healthz')),
    'the worker HTTP routes are missing from the surface');
  assert.ok(report.surface.some((entry) => entry.startsWith('schema:weles.')),
    'the API schemas are missing from the surface');
});
