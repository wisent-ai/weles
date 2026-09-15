/**
 * A page question Jeden cannot answer is a failure with a name, not an empty
 * answer.
 *
 * On 2026-09-10 a keeper run on the dedicated host asked forty page questions
 * in a row and received an empty string for each: every Jeden session died
 * before producing output, the vision helper swallowed the error into '', and
 * the browser loop kept asking until "browser agent exceeded 40 steps". The
 * only place the cause was written was the vision directory's json files.
 *
 * This drives the real helper with a Jeden binary path that cannot run - the
 * multi-step path the helper takes - and reads back what the loop and the
 * vision log now see.
 *
 * Run: node --test tests/observation/page-question.test.mjs
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const repo = resolve(import.meta.dirname, '../..');

const output = resolve(repo, '.wisent-output', 'page-question-tests', randomUUID());
const scratch = resolve(output, 'scratch');
mkdirSync(scratch, { recursive: true });
const report = {
  source_revision: process.env.WISENT_SOURCE_COMMIT
    || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  source_patch: process.env.WISENT_SOURCE_COMMIT ? null : 'source.patch',
  command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  compiled_sha256: Object.fromEntries(['vision/analyze', 'agent/jeden', 'session/flows'].map(name => [
    name, createHash('sha256').update(readFileSync(resolve(repo, `dist/${name}.js`))).digest('hex'),
  ])),
  observations: {},
};
if (report.source_patch) {
  writeFileSync(resolve(output, report.source_patch), execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repo }));
}
after(() => {
  report.vision_logs = existsSync(process.env.WELES_VISION_DIR)
    ? readdirSync(process.env.WELES_VISION_DIR)
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(resolve(process.env.WELES_VISION_DIR, name), 'utf8')))
    : [];
  writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`Page question evidence: ${resolve(output, 'report.json')}`);
});
process.env.WELES_CACHE_DIR = resolve(scratch, 'cache');
process.env.WELES_VISION_DIR = resolve(scratch, 'vision');
process.env.WELES_JEDEN_SESSION_ROOT = resolve(scratch, 'jeden');
process.env.WELES_JEDEN_BIN = resolve(scratch, 'no-such-jeden');
process.env.STADO_MODEL_ROUTER_URL = 'http://127.0.0.1:9';
process.env.WELES_STADO_MODEL_ROUTER_TOKEN = 'unused-in-this-case-'.repeat(4);
process.env.WELES_STADO_MODEL_ROUTER_AGENT_ID = 'weles';
process.env.WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET = 'unused-signing-secret-'.repeat(4);

const { askJedenAboutImage, PageQuestionError } = require(resolve(repo, 'dist/vision/analyze.js'));
const { loadFlow, saveFlow, replayFlow } = require(resolve(repo, 'dist/session/flows.js'));

// The smallest valid PNG: a 1x1 image, enough for the helper to write.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const QUESTION = 'Which character name is shown in the chat header?';

test('an unavailable native page read reports its question and actual cause', async () => {
  await assert.rejects(
    () => askJedenAboutImage(PNG_1X1, QUESTION, 'tier_0_bare'),
    (error) => {
      report.observations.direct_failure = String(error);
      assert.ok(error instanceof PageQuestionError);
      assert.ok(error.message.includes(QUESTION));
      assert.match(error.message, /no-such-jeden|ENOENT|spawn/i);
      return true;
    },
  );
  const logs = readdirSync(process.env.WELES_VISION_DIR).filter(name => name.endsWith('.json'));
  const record = JSON.parse(readFileSync(resolve(process.env.WELES_VISION_DIR, logs[0]), 'utf8'));
  assert.equal(record.question, QUESTION);
  assert.equal(record.answer, '');
  assert.match(String(record.error), /no-such-jeden|ENOENT|spawn/i);
});

test('cached replay retains a native read failure instead of reaching done', async () => {
  saveFlow('native-read', [
    { tool: 'read', args: { question: QUESTION } },
    { tool: 'done', args: { value: 'unverified' } },
  ]);
  const flow = loadFlow('native-read');
  const result = await replayFlow(flow, (_tool, args) =>
    askJedenAboutImage(PNG_1X1, args.question, 'tier_1_crop'));
  report.observations.replay = { ...result, error: String(result.error) };
  assert.equal(result.success, false);
  assert.equal(result.failedAtStep, 0);
  assert.ok(result.error instanceof PageQuestionError);
  assert.match(String(result.error), /no-such-jeden|ENOENT|spawn/i);
});

test('legacy caches are not reused and an unfinished replay cannot succeed', async () => {
  const legacy = { name: 'legacy', steps: [{ tool: 'done', args: { value: 'unverified' } }], lastSuccess: new Date().toISOString() };
  mkdirSync(resolve(process.env.WELES_CACHE_DIR, 'flows'), { recursive: true });
  writeFileSync(resolve(process.env.WELES_CACHE_DIR, 'flows', 'legacy.json'), JSON.stringify(legacy));
  report.observations.legacy_cache = loadFlow('legacy');
  assert.equal(report.observations.legacy_cache, null);
  saveFlow('unfinished', []);
  const result = await replayFlow(loadFlow('unfinished'), (_tool, args) =>
    askJedenAboutImage(PNG_1X1, args.question));
  report.observations.unfinished_replay = result;
  assert.equal(result.success, false);
});
