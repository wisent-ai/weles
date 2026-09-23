// Retained evidence for the native runtime packaging test: every command, its
// exit status and output files, and the exact source revision or patch.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '..', '..');

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function createEvidence({ input, archive, workerPayload }) {
  const output = join(REPO, '.wisent-output', 'native-runtime-tests', randomUUID());
  const scratch = join(output, 'scratch');
  mkdirSync(scratch, { recursive: true });
  const report = {
    source_revision: process.env.WISENT_SOURCE_COMMIT ?? null,
    source_patch: null,
    native_input_directory: input ? resolve(input) : null,
    native_archive: archive ? resolve(archive) : null,
    native_archive_sha256: archive ? digest(archive) : null,
    worker_payload: workerPayload ? resolve(workerPayload) : null,
    worker_payload_sha256: workerPayload ? digest(workerPayload) : null,
    native_binary_sha256: {},
    commands: [],
  };

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
  return { output, scratch, report, command };
}
