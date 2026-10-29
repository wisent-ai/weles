// Post-build journey of .wisent-release.json: the placement guard of the
// weles-worker payload this build staged, asked of this host's real Stado.
//
// The payload is unpacked from $WISENT_OUTPUT_DIR into the evidence directory
// Stado's build worker retains ($WISENT_TEST_EVIDENCE_DIR), and its own
// dist/session/placement/service-placement.js is imported, never the source
// tree. The guard must give the answer this host's Stado gives: it passes
// where `stado service status com.wisent.weles --json` places Weles on the
// target `stado registry self --name-only` names, and otherwise refuses with
// "is not placed on registry target '<target>'". Any other refusal (Stado not
// answering, a configuration Stado refuses) fails the journey with the
// guard's own words, which name the host and the Stado configuration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const output = process.env.WISENT_OUTPUT_DIR;
const evidence = process.env.WISENT_TEST_EVIDENCE_DIR;

await test('the staged placement guard answers what this host Stado answers', async () => {
  assert.ok(
    output,
    "WISENT_OUTPUT_DIR is required: Stado's build worker names the output of the build under test",
  );
  assert.ok(
    evidence,
    "WISENT_TEST_EVIDENCE_DIR is required: Stado's build worker names the qualification output it retains",
  );
  const unpacked = join(evidence, 'placement-journey', 'payload');
  mkdirSync(unpacked, { recursive: true });
  // The guard imports only Node's own modules, so the payload's package
  // document (its module type) and the guard itself are what is unpacked.
  execFileSync('tar', [
    '-xzf',
    join(output, 'payload', 'weles-worker.tar.gz'),
    '-C',
    unpacked,
    'package.json',
    'dist/session/placement/service-placement.js',
  ]);
  const stado = (args) =>
    execFileSync(process.env.STADO_BIN ?? 'stado', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const target = stado(['registry', 'self', '--name-only']);
  const rows = JSON.parse(
    stado(['service', 'status', 'com.wisent.weles', '--json']),
  );
  const placedHere = rows.some((row) => row.host === target);

  const guard = await import(
    pathToFileURL(
      join(unpacked, 'dist', 'session', 'placement', 'service-placement.js'),
    ).href
  );
  let refusal = null;
  try {
    guard.enforceWelesServicePlacement('placement-journey');
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(
    join(evidence, 'placement-journey', 'report.json'),
    JSON.stringify({ host: hostname(), target, placedHere, refusal }),
  );
  if (placedHere) {
    assert.equal(
      refusal,
      null,
      `the guard refused on the placed host: ${refusal}`,
    );
  } else {
    assert.match(
      refusal ?? '',
      new RegExp(`is not placed on registry target '${target}'`),
      `the guard must refuse naming this host's target, not fail to ask Stado: ${refusal}`,
    );
  }
});
