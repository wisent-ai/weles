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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const repo = resolve(import.meta.dirname, '../..');

// Throwaway state stays inside this checkout's ignored recordings directory,
// created here and removed when the case ends.
const scratch = resolve(repo, 'recordings', `page-question-${randomUUID()}`);
mkdirSync(scratch, { recursive: true });
process.env.WELES_VISION_DIR = resolve(scratch, 'vision');
process.env.WELES_JEDEN_SESSION_ROOT = resolve(scratch, 'jeden');
process.env.WELES_JEDEN_BIN = resolve(scratch, 'no-such-jeden');
process.env.STADO_MODEL_ROUTER_URL = 'http://127.0.0.1:9';
process.env.WELES_STADO_MODEL_ROUTER_TOKEN = 'unused-in-this-case-'.repeat(4);
process.env.WELES_STADO_MODEL_ROUTER_AGENT_ID = 'weles';
process.env.WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET = 'unused-signing-secret-'.repeat(4);

const { askJedenAboutImage } = require(resolve(repo, 'dist/vision/analyze.js'));

// The smallest valid PNG: a 1x1 image, enough for the helper to write.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const QUESTION = 'Which character name is shown in the chat header?';

test('a question Jeden cannot answer fails by name, with the question and the cause', async () => {
  try {
    await assert.rejects(
      () => askJedenAboutImage(PNG_1X1, QUESTION, 'tier_0_bare'),
      (error) => {
        const message = String(error.message);
        assert.match(message, /got no answer from Jeden/, 'the failure does not say the question went unanswered');
        assert.ok(message.includes(QUESTION), 'the failure does not name the question');
        assert.match(message, /no-such-jeden|ENOENT|spawn/i, 'the failure does not carry the cause');
        return true;
      },
    );
    const logs = readdirSync(process.env.WELES_VISION_DIR).filter((name) => name.endsWith('.json'));
    assert.equal(logs.length, 1, 'exactly one vision log is written for one question');
    const record = JSON.parse(readFileSync(resolve(process.env.WELES_VISION_DIR, logs[0]), 'utf8'));
    assert.equal(record.question, QUESTION);
    assert.equal(record.answer, '', 'no answer was produced');
    assert.match(String(record.error), /no-such-jeden|ENOENT|spawn/i, 'the vision log does not record the cause');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
