// A captcha no service solves ends in one error that names every service
// tried and why, against the real providers: CaptchaSolver is given an
// AntiCaptcha key and a CapSolver key that neither service issued, each
// service refuses the hCaptcha task itself, and the solve throws naming both
// services and AntiCaptcha's own error code. The run's captcha log holds an
// all_failed event with the same causes and no cost. A Turnstile solve with
// no key for the one service that solves it is refused as such, naming no
// service, and is logged with an empty cause list.
//
// The keys are random, so no provider account is charged; the providers and
// hCaptcha's demo page are reached over the network as a run reaches them,
// and the site key is read from the demo page's own markup.
//
// Usage: npm run build && node --test tests/captcha/provider-refusal.mjs
// Each run writes report.json under build/real-tests/captcha/provider-refusal-<stamp>/
// with the source revision, every refusal and the captcha log.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CaptchaSolver } from '../../dist/captcha/solver.js';
import { captchaSnapshot } from '../../dist/captcha/events.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(
  root,
  'build',
  'real-tests',
  'captcha',
  `provider-refusal-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const report = {
  revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  dirty: spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).stdout,
  refusals: [],
};

after(() => {
  report.captchaLog = captchaSnapshot();
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, '\t')}\n`);
});

// hCaptcha's own demo page, which states the site key it serves in its markup.
const HCAPTCHA_DEMO = 'https://accounts.hcaptcha.com/demo';

async function demoSiteKey() {
  const response = await fetch(HCAPTCHA_DEMO);
  const page = await response.text();
  const sitekey = page.match(/data-sitekey="(?<sitekey>[^"]+)"/)?.groups?.sitekey;
  assert.ok(sitekey, `${HCAPTCHA_DEMO} answered HTTP ${response.status} without a data-sitekey in its markup`);
  report.sitekey = sitekey;
  return sitekey;
}

/** Requires `solving` to be refused, keeps the refusal and answers its message. */
async function refused(solve, solving) {
  let message;
  await assert.rejects(solving, (error) => {
    assert.ok(error instanceof Error, `the solve threw ${String(error)}, not an Error`);
    message = error.message;
    return true;
  });
  report.refusals.push({ solve, message });
  return message;
}

test('every service refusing an hCaptcha task is named in one error', async () => {
  const sitekey = await demoSiteKey();
  const solver = new CaptchaSolver({
    anticaptcha: `not-issued-${randomUUID()}`,
    capsolver: `not-issued-${randomUUID()}`,
  });
  const message = await refused('hcaptcha', solver.solveHcaptcha(sitekey, HCAPTCHA_DEMO));
  assert.match(message, /^no captcha service solved hcaptcha: /);
  assert.match(message, /anticaptcha: anti-captcha refused createTask HCaptchaTaskProxyless: ERROR_KEY_DOES_NOT_EXIST/);
  assert.match(message, /; capsolver: capsolver refused createTask HCaptchaTaskProxyLess: /);
  const failed = captchaSnapshot().events.filter((event) => event.resource === 'hcaptcha' && event.outcome === 'all_failed');
  assert.equal(failed.length, Math.sign(Infinity), JSON.stringify(failed));
  const [event] = failed;
  assert.deepEqual(
    event.causes.map((cause) => cause.split(':').shift()),
    ['anticaptcha', 'capsolver'],
  );
  assert.equal(Object.hasOwn(event, 'cost_usd'), false, 'an unsolved challenge was priced');
});

test('a challenge no held key can solve is refused naming none', async () => {
  const sitekey = await demoSiteKey();
  const solver = new CaptchaSolver({ anticaptcha: `not-issued-${randomUUID()}` });
  const message = await refused('turnstile', solver.solveTurnstile(sitekey, HCAPTCHA_DEMO));
  assert.equal(message, 'no captcha service solves turnstile with a key Weles holds');
  const failed = captchaSnapshot().events.filter((event) => event.resource === 'turnstile' && event.outcome === 'all_failed');
  assert.deepEqual(failed.map((event) => event.causes), [[]]);
});
