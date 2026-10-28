// A provider that takes a callback (AntiCaptcha, CapMonster, CapSolver,
// 2captcha) pushes its answer to the Weles worker; the run never reads it
// from the provider again.
//
// 0. A worker whose WELES_CAPTCHA_CALLBACK_ORIGIN is not an HTTPS origin (not
//    an address, plain HTTP, carrying a path or credentials) does not start,
//    naming it; another spelling of an HTTPS origin starts it.
// 1. In a run no worker told where providers can answer (no
//    WELES_CAPTCHA_CALLBACK_URL), each callback service is refused before it
//    is asked, its cause in the solve's error naming the variable and who
//    states it.
// 2. The worker's real /captcha/answers/<run>/<token> route (answer-server.mjs,
//    run with a HOME of its own) and the built run side (dist/captcha/
//    providers/callback.js) meet: a POST to an address no run waits for is
//    answered 404 and leaves nothing; the first POST to the address a waiting
//    run drew is what that run's answer() resolves with, content type and body
//    as sent; a repeat before or after the run reads it is answered 404; the
//    files are gone after it.
// 3. A provider that refuses the task leaves no run waiting: AntiCaptcha and
//    2captcha are given keys they never issued, each refuses, and the run's
//    answers directory holds no waiting marker afterwards.
// 4. A run whose registration with the worker ends (as it does when the run
//    finishes, is cancelled or its child dies) takes its answers directory
//    with it, so a late callback is answered 404; a worker that starts clears
//    the answers an earlier server's runs left.
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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

/** The worker's declared environment with a HOME of the journey's own and `origin` as its callback origin. */
function workerEnvironment(origin) {
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    WELES_RECORDINGS_ROOT: join(directory, 'recordings'),
    WELES_API_HOST: 'localhost',
    WELES_API_PORT: String(process.pid),
    WELES_CAPTCHA_CALLBACK_ORIGIN: origin,
  };
}

const ANSWER_SERVER = join(root, 'tests', 'captcha', 'answer-server.mjs');

before(async () => {
  server = spawn(process.execPath, [ANSWER_SERVER], {
    cwd: root,
    env: workerEnvironment(''),
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

/** Points this process's solves at the route as the worker points run `run`'s. */
function useRoute(run) {
  process.env.WELES_CAPTCHA_CALLBACK_URL = new URL(`/captcha/answers/${run}/`, route.origin).toString();
  process.env.WELES_CAPTCHA_ANSWERS_DIR = join(route.answers, run);
  return join(route.answers, run);
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

test('a callback origin that is not an HTTPS origin stops the worker naming it', async () => {
  for (const origin of ['not an address', 'http://weles.example', 'https://weles.example/captcha', 'https://user@weles.example']) {
    const started = spawnSync(process.execPath, [ANSWER_SERVER], { cwd: root, env: workerEnvironment(origin), encoding: 'utf8' });
    report.steps.push({ step: `origin ${origin}`, status: started.status, stderr: started.stderr.split('\n').find((line) => line.includes('WELES_CAPTCHA_CALLBACK_ORIGIN')) });
    assert.notEqual(started.status, Number(), `the worker started with origin ${origin}`);
    assert.match(started.stderr, new RegExp(`WELES_CAPTCHA_CALLBACK_ORIGIN is ${origin.replace(/[./@]/g, '\\$&')}: set it to the public HTTPS origin`));
  }
  // Another spelling of an HTTPS origin (capitals, a closing slash) is that origin, and the worker starts.
  const spelled = spawn(process.execPath, [ANSWER_SERVER], { cwd: root, env: workerEnvironment('https://Weles.example/'), stdio: ['ignore', 'pipe', 'pipe'] });
  const [line] = await once(createInterface({ input: spelled.stdout }), 'line');
  spelled.kill();
  report.steps.push({ step: 'origin https://Weles.example/', started: JSON.parse(line) });
});

test('a callback service is refused before it is asked when the run has no callback address', async () => {
  delete process.env.WELES_CAPTCHA_CALLBACK_URL;
  delete process.env.WELES_CAPTCHA_ANSWERS_DIR;
  const solver = new CaptchaSolver({ anticaptcha: `not-issued-${randomUUID()}` });
  const message = await refusal(solver.solveHcaptcha('site-key-unread', DEMO));
  report.steps.push({ step: 'no callback address', message });
  assert.match(message, /anti-captcha cannot be given a task: WELES_CAPTCHA_CALLBACK_URL is not set/);
  assert.match(message, /WELES_CAPTCHA_CALLBACK_ORIGIN/);
});

test('the worker route hands a pushed answer to the run waiting for it', async () => {
  const run = `journey-${randomUUID()}`;
  const answers = useRoute(run);
  const stray = await fetch(new URL(`/captcha/answers/${run}/${randomUUID()}`, route.origin), {
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
  assert.equal(posted.status, http.HTTP_STATUS_OK);
  assert.deepEqual(await posted.json(), { ok: true });
  const early = await fetch(callback.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"status":"processing"}' });
  report.steps.push({ step: 'callback repeated before the run read it', status: early.status });
  assert.equal(early.status, http.HTTP_STATUS_NOT_FOUND);
  const answer = await callback.answer();
  report.steps.push({ step: 'pushed answer', url: callback.url, answer });
  assert.deepEqual(answer, { contentType: 'application/json', body: pushed }, 'the first callback was not the one kept');
  assert.deepEqual(readdirSync(answers), []);
  const repeated = await fetch(callback.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pushed });
  report.steps.push({ step: 'callback repeated after the run read it', status: repeated.status });
  assert.equal(repeated.status, http.HTTP_STATUS_NOT_FOUND);
});

test('a provider that refuses the task leaves no run waiting', async () => {
  const answers = useRoute(`journey-${randomUUID()}`);
  for (const [service, solve] of [
    ['anticaptcha', (solver) => solver.solveHcaptcha('site-key-unread', DEMO)],
    ['twocaptcha', (solver) => solver.solveFuncaptcha('public-key-unread', DEMO)],
  ]) {
    const solver = new CaptchaSolver({ [service]: `not-issued-${randomUUID()}` });
    const message = await refusal(solve(solver));
    const left = readdirSync(answers);
    report.steps.push({ step: `${service} refuses`, message, left });
    assert.doesNotMatch(message, /cannot be given a task/);
    assert.deepEqual(left, []);
  }
});

test('a run that ended takes its answers with it, and a late callback is answered 404', async () => {
  // The worker's own registration, read with the same declaration and home
  // the route runs with, so it removes the directory the route reads.
  Object.assign(process.env, workerEnvironment(''));
  const { registerRunningRun } = await import('../../src/worker/weles-api-server/run/running-runs.mjs');
  const run = `journey-${randomUUID()}`;
  const answers = useRoute(run);
  const callback = await providerCallback('anti-captcha');
  const unregister = registerRunningRun(run, {
    action: 'captcha-journey',
    kind: 'journey',
    startedAt: new Date().toISOString(),
    cancel: () => {},
    describe: () => 'waiting for a captcha callback',
  });
  unregister();
  const late = await fetch(callback.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"status":"ready"}' });
  report.steps.push({ step: 'callback after the run ended', status: late.status, answersLeft: readdirSync(route.answers).includes(run) });
  assert.equal(late.status, http.HTTP_STATUS_NOT_FOUND);
  assert.equal(readdirSync(route.answers).includes(run), false, 'the ended run left its answers directory');
  await assert.rejects(callback.abandon(), /ENOENT/);
});

test('a worker that starts clears the answers an earlier server\'s runs left', async () => {
  const stale = join(route.answers, `journey-${randomUUID()}`);
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, `${randomUUID()}.waiting`), '');
  const restarted = spawn(process.execPath, [ANSWER_SERVER], { cwd: root, env: workerEnvironment(''), stdio: ['ignore', 'pipe', 'pipe'] });
  await once(createInterface({ input: restarted.stdout }), 'line');
  restarted.kill();
  const left = existsSync(stale);
  report.steps.push({ step: 'answers left by an earlier server', left });
  assert.equal(left, false, 'a starting worker kept answers no run of its own waits for');
});
