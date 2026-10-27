// A provider's answer reaches the run that created the task by being pushed
// to the Weles worker, never by reading the provider again.
//
// 1. A run no worker told where providers can answer (no
//    WELES_CAPTCHA_CALLBACK_URL) is refused before any provider is asked, and
//    the refusal names the variable and who states it.
// 2. The worker's real /captcha/answers/ route (answer-server.mjs, run with a
//    HOME of its own) and the built run side (dist/captcha/providers/
//    callback.js) meet: a POST to an address no run waits for is answered 404
//    and leaves nothing; a POST to the address a waiting run drew is what that
//    run's answer() resolves with, content type and body as sent, and the
//    files are gone after it.
// 3. A provider that refuses the task leaves no run waiting: AntiCaptcha and
//    2captcha are given keys they never issued, each refuses, and the answers
//    directory holds no waiting marker afterwards.
//
// Step 2 posts as a provider posts; that a provider really calls back needs a
// public HTTPS origin routed to a worker (WELES_CAPTCHA_CALLBACK_ORIGIN), which
// this journey does not have.
//
// Usage: npm run build && node --test tests/captcha/provider-callback.mjs
// Each run writes report.json under build/real-tests/captcha/provider-callback-<stamp>/.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { constants as http } from 'node:http2';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { providerCallback } from '../../dist/captcha/providers/callback.js';
import { CaptchaSolver } from '../../dist/captcha/solver.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(
  root,
  'build',
  'real-tests',
  'captcha',
  `provider-callback-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const report = {
  revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  dirty: spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).stdout,
  steps: [],
};
// hCaptcha's own demo page: a real page a task can name.
const DEMO = 'https://accounts.hcaptcha.com/demo';
let server;
let route;

before(async () => {
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });
  server = spawn(process.execPath, [join(root, 'tests', 'captcha', 'answer-server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      WELES_RECORDINGS_ROOT: join(directory, 'recordings'),
      WELES_API_HOST: 'localhost',
      WELES_API_PORT: String(process.pid),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [line] = await once(createInterface({ input: server.stdout }), 'line');
  route = JSON.parse(line);
  report.route = route;
});

after(() => {
  server?.kill();
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, '\t')}\n`);
});

function useRoute() {
  process.env.WELES_CAPTCHA_CALLBACK_URL = new URL('/captcha/answers/', route.origin).toString();
  process.env.WELES_CAPTCHA_ANSWERS_DIR = route.answers;
}

/** Requires `solving` to be refused and answers the refusal's message. */
async function refusal(solving) {
  let message;
  await assert.rejects(solving, (error) => {
    message = error.message;
    return true;
  });
  return message;
}

test('a run with no callback address is refused before any provider is asked', async () => {
  delete process.env.WELES_CAPTCHA_CALLBACK_URL;
  delete process.env.WELES_CAPTCHA_ANSWERS_DIR;
  const solver = new CaptchaSolver({ anticaptcha: `not-issued-${randomUUID()}` });
  const message = await refusal(solver.solveHcaptcha('site-key-unread', DEMO));
  report.steps.push({ step: 'no callback address', message });
  assert.match(message, /anti-captcha cannot be given a task: WELES_CAPTCHA_CALLBACK_URL is not set/);
  assert.match(message, /WELES_CAPTCHA_CALLBACK_ORIGIN/);
});

test('the worker route hands a pushed answer to the run waiting for it', async () => {
  useRoute();
  const stray = await fetch(new URL(`/captcha/answers/${randomUUID()}`, route.origin), {
    method: 'POST',
    body: '{}',
  });
  report.steps.push({ step: 'answer nobody waits for', status: stray.status, body: await stray.json() });
  assert.equal(stray.status, http.HTTP_STATUS_NOT_FOUND);

  const callback = await providerCallback('anti-captcha');
  assert.ok(callback.url.startsWith(process.env.WELES_CAPTCHA_CALLBACK_URL), callback.url);
  const pushed = JSON.stringify({
    status: 'ready',
    solution: { gRecaptchaResponse: `token-${randomUUID()}` },
  });
  const posted = await fetch(callback.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: pushed,
  });
  assert.equal(posted.status, http.HTTP_STATUS_OK, await posted.text());
  const answer = await callback.answer();
  report.steps.push({ step: 'pushed answer', url: callback.url, answer });
  assert.deepEqual(answer, { contentType: 'application/json', body: pushed });
  assert.deepEqual(readdirSync(route.answers), []);
});

test('a provider that refuses the task leaves no run waiting', async () => {
  useRoute();
  for (const [service, solve] of [
    ['anticaptcha', (solver) => solver.solveHcaptcha('site-key-unread', DEMO)],
    ['twocaptcha', (solver) => solver.solveFuncaptcha('public-key-unread', DEMO)],
  ]) {
    const solver = new CaptchaSolver({ [service]: `not-issued-${randomUUID()}` });
    const message = await refusal(solve(solver));
    const left = readdirSync(route.answers);
    report.steps.push({ step: `${service} refuses`, message, left });
    assert.doesNotMatch(message, /cannot be given a task/);
    assert.deepEqual(left, []);
  }
});
