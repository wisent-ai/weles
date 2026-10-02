import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaToolCandidates } from '../../dist/runtime/media-tools.js';
import { evidenceFor } from '../security/evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await evidenceFor('capture-prerequisites');
evidence.report.scope = 'real_cli_preflight_refusals_only';
evidence.report.browser_flow = 'not_run';
evidence.report.node_version = process.version;
const encoder = mediaToolCandidates('ffmpeg').find((path) => existsSync(path));
const failures = [];
try {
  for (const prerequisite of ['encoder', 'probe']) {
    const home = await mkdtemp(join(root, 'build/real-tests/capture-prerequisites/home-'));
    const entry = join(root, 'src/trajectories/generic/capture.mjs');
    const plan = {
      batch: 'recording-prerequisites', site_slug: 'weles',
      source_url: 'https://weles.wisent.com/docs', axis: 'composition',
      viewport: { width: 640, height: 480, device_scale_factor: 1 },
      full_page: false, steps: [], record_seconds: 1,
      artifact_prefix: 'stado://weles-captures/recording-prerequisites/',
    };
    const overrides = {
      HOME: home, WELES_RECORDINGS_ROOT: join(home, 'recordings'),
      WELES_RUN_OUTPUT_DIR: join(home, 'runs'), ACTION_LOG_ID: 'prerequisite-refusal',
      WELES_CREDENTIALS_FILE: '', SKARBIEC_WORKLOAD_ID: '', SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: '',
      GENERIC_CAPTURE_PLAN: JSON.stringify(plan),
      WELES_FFMPEG_BIN: prerequisite === 'encoder' ? join(home, 'missing-ffmpeg') : encoder,
      WELES_FFPROBE_BIN: join(home, 'missing-ffprobe'),
    };
    const operation = { prerequisite, command: [process.execPath, entry], cwd: home, environment_overrides: overrides };
    evidence.report.operations.push(operation);
    try {
      if (prerequisite === 'probe' && !encoder) throw new Error('No installed ffmpeg is available for the ffprobe prerequisite case');
      const result = spawnSync(process.execPath, [entry], {
        cwd: home, env: { ...process.env, ...overrides }, encoding: 'utf8',
      });
      Object.assign(operation, {
        exit_status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
        error: result.error?.message ?? null, home_entries_after: await readdir(home, { recursive: true }),
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      const persisted = JSON.parse(await readFile(join(home, 'recordings/prerequisite-refusal/generic_capture/capture_result.json'), 'utf8'));
      operation.capture_result = persisted;
      assert.equal(persisted.ok, false);
      assert.equal(persisted.error_details.code, prerequisite === 'encoder' ? 'CAPTURE_ENCODER_UNAVAILABLE' : 'CAPTURE_PROBE_UNAVAILABLE');
      assert.equal(persisted.error_details[prerequisite], overrides[prerequisite === 'encoder' ? 'WELES_FFMPEG_BIN' : 'WELES_FFPROBE_BIN']);
      assert.deepEqual(persisted.artifacts, [], 'a refused recording must not claim uploaded evidence');
      assert.deepEqual(persisted.steps_executed, [], 'a missing recording tool must be refused before page actions');
      assert.equal(operation.home_entries_after.some(path => path.endsWith('.webm') || path.endsWith('.png')), false,
        'a prerequisite refusal must not invent captured media');
      operation.status = 'passed';
    } catch (error) {
      operation.status = 'failed';
      operation.failure = error.message;
      failures.push(`${prerequisite}: ${error.message}`);
    } finally {
      await rm(home, { recursive: true });
    }
  }
  evidence.report.status = failures.length ? 'failed' : 'passed';
  evidence.report.failures = failures;
  if (failures.length) process.exitCode = 1;
} catch (error) {
  evidence.report.status = 'failed';
  evidence.report.failure = error.message;
  process.exitCode = 1;
} finally {
  await evidence.finish();
}
