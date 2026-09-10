/**
 * Writing back what a release published, through the real
 * `weles release adopt-baseline` command.
 *
 * The version gate judges every revision against two documents: the baseline,
 * which says what the last release exposes, and the declaration, which says
 * which version that was. Both were kept by hand and publishing updated
 * neither, so this repository ended up claiming a 0.5.72 baseline and a 0.6.7
 * manifest while the newest published release was 0.5.49 — and the gate then
 * refused every revision, including revisions that changed no surface at all.
 * `release-worker` now runs this command after it publishes.
 *
 * The cases below are what a caller observes: the documents the command
 * writes, and the two refusals that keep the record honest.
 *
 * Scratch files are written under the repository's ignored `build/` directory
 * rather than the system temporary directory, which this workshop keeps clear.
 *
 * Run: node --test tests/release/baseline.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const CLI = join(REPO, 'dist/cli.js');
const PUBLISHED = ['cmd:weles', 'cmd:weles doctor', 'export:AsyncNewBrowser', 'http:GET /api/v1/health'];

function workspace() {
  const scratch = join(REPO, 'build');
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, 'adopt-baseline-'));
}

function adopt({ published = { surface: PUBLISHED }, released, reason, correcting, recorded = '0.5.49' }) {
  const directory = workspace();
  const paths = {
    published: join(directory, 'published-surface.json'),
    baseline: join(directory, 'released-surface.json'),
    declaration: join(directory, 'version-change.json'),
  };
  writeFileSync(paths.published, `${JSON.stringify(published)}\n`);
  writeFileSync(paths.baseline, `${JSON.stringify({ surface: PUBLISHED, version: recorded })}\n`);
  writeFileSync(paths.declaration, `${JSON.stringify({ schema: 'weles.version-change.v1' })}\n`);
  const argv = [
    CLI, 'release', 'adopt-baseline',
    '--released', released,
    '--published-surface', paths.published,
    '--reason', reason,
    '--baseline', paths.baseline,
    '--declaration', paths.declaration,
  ];
  if (correcting) argv.push('--correcting', correcting);
  const run = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    paths,
    read,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('adopting a release stamps the baseline with the version that was published', () => {
  const run = adopt({
    released: '0.5.50',
    reason: 'Release 0.5.50 published this surface from the tagged revision.',
  });
  try {
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.released, '0.5.50');
    assert.equal(report.previous, '0.5.49');
    assert.equal(report.corrected, null);
    assert.equal(report.surfaceEntries, PUBLISHED.length);

    const baseline = run.read(run.paths.baseline);
    // The published document carries no version of its own; the whole point of
    // the write-back is that the baseline now says which release it describes.
    assert.equal(baseline.version, '0.5.50');
    assert.deepEqual(baseline.surface, [...PUBLISHED].sort());

    const declaration = run.read(run.paths.declaration);
    assert.equal(declaration.current, '0.5.50');
    assert.equal(declaration.candidate, '0.5.50');
    assert.equal(declaration.breaking, false);
    assert.match(declaration.reason, /Release 0\.5\.50 published this surface/);
  } finally {
    run.cleanup();
  }
});

test('a baseline that would move backwards is refused until the override is named', () => {
  const run = adopt({
    released: '0.5.40',
    recorded: '0.5.49',
    reason: 'An older release cannot describe a newer baseline.',
  });
  try {
    assert.equal(run.status, 1);
    assert.match(run.stderr, /refusing to record 0\.5\.40 as published over 0\.5\.49/);
    assert.match(run.stderr, /--correcting 0\.5\.49/);
    // The refusal leaves the record it declined to change.
    assert.equal(run.read(run.paths.baseline).version, '0.5.49');
  } finally {
    run.cleanup();
  }
});

test('naming the version that was never published adopts the older release', () => {
  const run = adopt({
    released: '0.5.40',
    recorded: '0.5.49',
    correcting: '0.5.49',
    reason: 'No tag and no release ever carried 0.5.49, so the record named a version nothing published.',
  });
  try {
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.released, '0.5.40');
    assert.equal(report.corrected, '0.5.49');
    assert.equal(run.read(run.paths.baseline).version, '0.5.40');
    assert.equal(run.read(run.paths.declaration).current, '0.5.40');
  } finally {
    run.cleanup();
  }
});

test('a published document naming no surface is refused', () => {
  const run = adopt({
    published: { surface: [] },
    released: '0.5.50',
    reason: 'An empty baseline would make every later surface look additive.',
  });
  try {
    assert.equal(run.status, 1);
    assert.match(run.stderr, /names no surface/);
    assert.deepEqual(run.read(run.paths.baseline).surface, [...PUBLISHED].sort());
  } finally {
    run.cleanup();
  }
});
