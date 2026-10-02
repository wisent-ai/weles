import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = 'src/trajectories/gmail/gmail_login_search.mjs';
const evidence = await evidenceFor('gmail-query-required');
const { report } = evidence;
report.scope = 'local_query_refusal_before_credentials_and_browser';
report.browser_flow = 'not_run';
let home;
try {
  report.source_sha256 = createHash('sha256').update(await readFile(join(root, entry))).digest('hex');
  const scratch = join(root, 'build/real-tests/gmail-query-required');
  await mkdir(scratch, { recursive: true });
  home = await mkdtemp(join(scratch, 'home-'));
  const environment = { ...process.env, HOME: home };
  delete environment.GM_QUERY;
  const result = spawnSync(process.execPath, [entry], {
    cwd: root, env: environment, encoding: 'utf8',
  });
  report.operations.push({
    command: [process.execPath, entry], cwd: root,
    environment: { HOME: home, GM_QUERY: null },
    exit_status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr,
    error: result.error?.message ?? null,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, 'the real entrypoint must refuse an absent query');
  assert.match(result.stderr, /GMAIL_QUERY_REQUIRED: GM_QUERY must be a nonempty Gmail search query/);
  report.home_entries = await readdir(home);
  assert.deepEqual(report.home_entries, [], 'query refusal must not create account or browser state');
  report.status = 'passed';
  report.qualified_cases = 1;
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  if (home) await rm(home, { recursive: true });
  await evidence.finish();
}
