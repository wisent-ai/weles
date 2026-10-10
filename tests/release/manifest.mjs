import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Qualify the actual CLI with an accepted deployment manifest, not browser installation.
const root = fileURLToPath(new URL('../../', import.meta.url));
const required = (name) => {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

await test('release CLI accepts canonical artifacts and preserves named refusals', async () => {
  const directory = join(
    root,
    'build/real-tests/release-manifest',
    randomUUID(),
  );
  mkdirSync(directory, { recursive: true });
  const report = { commands: [], verdict: 'failed' };
  const save = () =>
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
  const execute = async (binary, args) => {
    const row = { command: [binary, ...args], stdout: '', stderr: '' };
    report.commands.push(row);
    save();
    const child = spawn(binary, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      row.stdout += chunk;
      save();
    });
    child.stderr.on('data', (chunk) => {
      row.stderr += chunk;
      save();
    });
    await new Promise((resolve, reject) => {
      child.once('error', (error) => {
        row.launch_error = String(error);
        save();
        reject(error);
      });
      child.once('close', (code, signal) => {
        row.exit_status = code;
        row.signal = signal;
        save();
        resolve();
      });
    });
    return row;
  };
  try {
    const binary = required('WELES_BIN');
    const revision = await execute('git', ['rev-parse', 'HEAD']);
    report.source_revision = revision.stdout.trim();
    assert.equal(
      report.source_revision,
      required('WELES_TEST_SOURCE_REVISION'),
    );
    assert.equal(revision.signal, null);
    assert.ok(Number.isInteger(revision.exit_status));
    const successExit = revision.exit_status;
    report.binary_sha256 = digest(readFileSync(binary));
    assert.equal(report.binary_sha256, required('WELES_TEST_BINARY_SHA256'));
    const manifestPath = required('WELES_TEST_DEPLOYMENT_MANIFEST');
    const bytes = readFileSync(manifestPath);
    const manifest = JSON.parse(bytes);
    writeFileSync(join(directory, 'accepted-manifest.json'), bytes);
    const source = required('WELES_TEST_DEPLOYMENT_SOURCE_REVISION');
    const tag = required('WELES_TEST_CANDIDATE_TAG');
    const validate = (path) =>
      execute(binary, [
        'release',
        'validate-manifest',
        '--manifest',
        path,
        '--source-revision',
        source,
        '--candidate-tag',
        tag,
        '--json',
      ]);
    const accepted = await validate(manifestPath);
    assert.equal(accepted.signal, null);
    assert.equal(accepted.exit_status, successExit, accepted.stderr);
    const verdict = JSON.parse(accepted.stdout);
    assert.equal(verdict.schema, manifest.schema);
    assert.equal(verdict.deploymentId, manifest.deploymentId);
    assert.equal(verdict.sourceRevision, source);
    assert.equal(verdict.sha256, digest(bytes));

    const refuse = async (name, change, cause) => {
      const invalid = structuredClone(manifest);
      const [artifact] = invalid.worker.artifacts;
      assert.ok(artifact, 'accepted deployment must contain a worker artifact');
      change(artifact);
      const path = join(directory, `${name}.json`);
      writeFileSync(path, JSON.stringify(invalid));
      const answer = await validate(path);
      assert.equal(answer.signal, null, 'a signal is not a manifest refusal');
      assert.notEqual(
        answer.exit_status,
        successExit,
        'invalid manifest was accepted',
      );
      assert.ok(`${answer.stdout}\n${answer.stderr}`.includes(cause), cause);
    };
    await refuse(
      'outside-archive',
      (artifact) => {
        artifact.entrypoint = '../outside';
      },
      'worker.artifacts[0].entrypoint',
    );
    await refuse(
      'obsolete-url',
      (artifact) => {
        artifact.url = 'https://example.invalid/release.tar.gz';
        delete artifact.uri;
      },
      'missing=[uri] unexpected=[url]',
    );
    await refuse(
      'legacy-platform',
      (artifact) => {
        artifact.platform = 'linux-x64';
      },
      'worker.artifacts[0].platform',
    );
    await refuse(
      'non-release-uri',
      (artifact) => {
        artifact.uri = 'https://example.invalid/release.tar.gz';
      },
      'worker.artifacts[0].uri',
    );
    assert.equal(
      digest(readFileSync(manifestPath)),
      digest(bytes),
      'qualification altered the accepted manifest',
    );
    report.verdict = 'passed';
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    save();
  }
});
