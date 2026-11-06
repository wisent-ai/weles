// Actual CLI, real ffmpeg and isolated filesystem; no browser or provider mutation.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await evidenceFor('browser-runtime');
const home = join(root, 'build/real-tests/browser-runtime', randomUUID());
const cache = join(home, 'playwright');
const sources = [
  'src/cli/diagnostics.ts',
  'src/cli/diagnostics/browser-runtime.ts',
  'src/runtime/media-tools.ts',
  'tests/diagnostics/browser-runtime.mjs',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const required = (name) => {
  const value = process.env[name];
  if (!value?.trim())
    throw new Error(`${name} is required for real runtime qualification`);
  return value;
};
let failure;
try {
  assert.equal(
    required('WELES_SOURCE_REVISION'),
    evidence.report.source_revision,
  );
  execFileSync('git', ['ls-files', '--error-unmatch', '--', ...sources], {
    cwd: root,
  });
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', ...sources], {
    cwd: root,
  });
  const binary = resolve(required('WELES_BIN'));
  const encoder = resolve(required('WELES_TEST_FFMPEG'));
  const digest = hash(await readFile(binary));
  assert.equal(digest, required('WELES_CLI_SHA256'));
  evidence.report.binary_sha256 = digest;
  evidence.report.encoder = {
    path: encoder,
    sha256: hash(await readFile(encoder)),
  };
  evidence.report.source_digests = {};
  for (const source of sources)
    evidence.report.source_digests[source] = hash(
      await readFile(join(root, source)),
    );
  const require = createRequire(import.meta.url);
  let directory = dirname(require.resolve('playwright-core'));
  let manifest;
  for (;;) {
    try {
      manifest = await readFile(join(directory, 'browsers.json'));
      break;
    } catch (cause) {
      if (cause.code !== 'ENOENT' || dirname(directory) === directory)
        throw cause;
      directory = dirname(directory);
    }
  }
  evidence.report.manifest_sha256 = hash(manifest);
  const declared = JSON.parse(manifest).browsers.find(
    (entry) => entry.name === 'ffmpeg',
  );
  assert.ok(
    declared?.revision,
    'the real dependency must declare its ffmpeg revision',
  );
  const name =
    process.platform === 'darwin'
      ? 'ffmpeg-mac'
      : process.platform === 'win32'
        ? 'ffmpeg-win64.exe'
        : 'ffmpeg-linux';
  const executable = join(cache, `ffmpeg-${declared.revision}`, name);
  const marker = join(dirname(executable), 'INSTALLATION_COMPLETE');
  await mkdir(dirname(executable), { recursive: true });
  function doctor(label) {
    const result = spawnSync(binary, ['doctor', '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PLAYWRIGHT_BROWSERS_PATH: cache },
    });
    evidence.report.operations.push({
      label,
      command: [binary, 'doctor', '--json'],
      exit_status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    const report = JSON.parse(result.stdout);
    const runtime = report.dependencies.browserRuntime;
    assert.ok(runtime, 'doctor must retain the recording runtime result');
    const [component] = runtime.components;
    assert.equal(component.expectedPath, executable);
    assert.deepEqual(component.command, [executable, '-version']);
    assert.equal(component.revision, declared.revision);
    if (!runtime.ok) {
      assert.equal(report.ok, false);
      // Node successful exit status: https://nodejs.org/api/process.html#exit-codes
      assert.notEqual(result.status, 0);
    }
    return { runtime, component };
  }
  await writeFile(marker, '');
  const absent = doctor('stale install marker with missing encoder');
  assert.equal(absent.runtime.ok, false);
  assert.equal(absent.component.failure.code, 'ENOENT');
  assert.equal(await readFile(marker, 'utf8'), '');
  await mkdir(executable);
  const directoryResult = doctor('directory instead of encoder');
  assert.equal(directoryResult.runtime.ok, false);
  assert.equal(directoryResult.component.present, false);
  await rm(executable, { recursive: true });
  await copyFile(encoder, executable);
  // Owner-only non-executable file: https://nodejs.org/api/fs.html#file-modes
  await chmod(executable, 0o600);
  const denied = doctor('actual encoder without execute permission');
  assert.equal(denied.runtime.ok, false);
  assert.equal(denied.component.present, true);
  assert.equal(denied.component.failure.code, 'EACCES');
  assert.equal(
    hash(await readFile(executable)),
    evidence.report.encoder.sha256,
  );
  await rm(executable);
  await rm(marker);
  await symlink(encoder, executable);
  const ready = doctor('real executable without an install marker');
  assert.equal(ready.runtime.ok, true);
  assert.equal(ready.component.ok, true);
  const actual = execFileSync(encoder, ['-version'], { encoding: 'utf8' });
  assert.equal(ready.component.output, actual);
  assert.equal(
    hash(await readFile(executable)),
    evidence.report.encoder.sha256,
  );
  evidence.report.status = 'passed';
} catch (cause) {
  failure = cause;
  evidence.report.status = 'failed';
  evidence.report.error = cause.stack;
} finally {
  try {
    await rm(home, { recursive: true, force: true });
  } catch (cause) {
    evidence.report.status = 'failed';
    evidence.report.cleanup_error = cause.stack;
    failure = failure
      ? new AggregateError([failure, cause], 'journey and cleanup failed')
      : cause;
  }
  try {
    await evidence.finish();
  } catch (cause) {
    failure = failure
      ? new AggregateError(
          [failure, cause],
          'journey and evidence publication failed',
        )
      : cause;
  }
}
if (failure) throw failure;
