import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await evidenceFor('discord-action-preflight');
evidence.report.scope = 'preflight_refusals_only';
evidence.report.browser_flow = 'not_run';
evidence.report.node_version = process.version;
evidence.report.source_sha256 = {};
const friend = 'src/trajectories/discord/actions/send_friend_request.mjs';
const forum = 'src/trajectories/discord/actions/post/create_forum_post.mjs';
const thread = 'src/trajectories/discord/actions/post/create_thread.mjs';
for (const path of [friend, forum, thread, 'tests/discord/action-preflight.mjs']) {
  evidence.report.source_sha256[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
}
const scenarios = [
  { name: 'missing_friend_target', entry: friend, diagnostics: ['DISCORD_TARGET_HANDLE'] },
  { name: 'missing_forum_input', entry: forum, diagnostics: ['FORUM_CHANNEL_PATH', 'POST_TITLE', 'POST_BODY'] },
  { name: 'invalid_forum_channel', entry: forum,
    settings: { FORUM_CHANNEL_PATH: 'not/a/channel/path', POST_TITLE: 'Input refusal title', POST_BODY: 'Input refusal body' },
    diagnostics: ['DISCORD_FORUM_CHANNEL_INVALID', 'not/a/channel/path'] },
  { name: 'missing_thread_input', entry: thread, diagnostics: ['SERVER_CHANNEL_PATH', 'TARGET_MESSAGE_SUBSTRING', 'THREAD_NAME'] },
  { name: 'invalid_thread_channel', entry: thread,
    settings: { SERVER_CHANNEL_PATH: 'not/a/channel/path', TARGET_MESSAGE_SUBSTRING: 'Input refusal parent', THREAD_NAME: 'Input refusal thread' },
    diagnostics: ['DISCORD_THREAD_CHANNEL_INVALID', 'not/a/channel/path'] },
];
const failures = [];
try {
  for (const scenario of scenarios) {
    const home = await mkdtemp(join(root, 'build/real-tests/discord-action-preflight/home-'));
    const entry = join(root, scenario.entry);
    const overrides = {
      HOME: home, WELES_RUN_OUTPUT_DIR: join(home, 'runs'),
      WELES_CREDENTIALS_FILE: '', SKARBIEC_WORKLOAD_ID: '', SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: '',
      DISCORD_TARGET_HANDLE: '', FORUM_CHANNEL_PATH: '', POST_TITLE: '', POST_BODY: '',
      POST_TAGS: '', SERVER_CHANNEL_PATH: '', TARGET_MESSAGE_SUBSTRING: '', THREAD_NAME: '', THREAD_FIRST_MESSAGE: '',
      ...scenario.settings,
    };
    const operation = { scenario: scenario.name, command: [process.execPath, entry], cwd: home, environment_overrides: overrides };
    evidence.report.operations.push(operation);
    try {
      const result = spawnSync(process.execPath, [entry], {
        cwd: home, env: { ...process.env, ...overrides }, encoding: 'utf8',
      });
      Object.assign(operation, {
        exit_status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
        error: result.error?.message ?? null, home_entries_after: await readdir(home, { recursive: true }),
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null, 'the CLI must return its own refusal');
      assert.equal(result.status, 1, result.stderr || result.stdout);
      for (const diagnostic of scenario.diagnostics) {
        assert.ok(`${result.stdout}\n${result.stderr}`.includes(diagnostic), `the refusal must identify ${diagnostic}`);
      }
      assert.deepEqual(operation.home_entries_after, [], 'refused input must not produce a browser run or action receipt');
      operation.status = 'passed';
    } catch (error) {
      operation.status = 'failed';
      operation.failure = error.message;
      failures.push(`${scenario.name}: ${error.message}`);
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
