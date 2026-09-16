/**
 * The model route the browser loop takes, against the real Brama gateway.
 *
 * A single-turn decision is asked of Brama directly, signed with this agent's
 * identity and asking for this agent's alias. Before that, the call spawned
 * whatever `jeden` the host's PATH held: on 2026-09-07 the binary on the
 * dedicated host asked Brama for a subscription rather than the alias, and
 * every browser task there died with `subscription_unavailable` while the same
 * alias through the same resolver answered on the first try. Text decisions
 * still use that alias; screenshots need the authorized, image-aware `best`
 * selector. The image case has no DOM or heading in its prompt, so a filename
 * or text-only request cannot substitute for reading the pixels.
 *
 * The turn needs what the runtime needs: `STADO_MODEL_ROUTER_URL`,
 * `WELES_STADO_MODEL_ROUTER_TOKEN`, `WELES_STADO_MODEL_ROUTER_AGENT_ID` and
 * `WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET`. A missing one fails the test by
 * name instead of skipping it.
 *
 * Run: node --test tests/agent/model-route.test.mjs
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { callJeden, WELES_AGENT_MODEL } = require(resolve(import.meta.dirname, '../../dist/agent/jeden.js'));
const repo = resolve(import.meta.dirname, '../..');
const output = resolve(repo, '.wisent-output', 'model-route-tests', randomUUID());
mkdirSync(output, { recursive: true });
const report = {
  source_revision: process.env.WISENT_SOURCE_COMMIT
    || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  compiled_sha256: Object.fromEntries(['agent/jeden', 'agent/model/message'].map(name => [
    name, createHash('sha256').update(readFileSync(resolve(repo, `dist/${name}.js`))).digest('hex'),
  ])),
  observations: {},
};
if (!process.env.WISENT_SOURCE_COMMIT) {
  report.source_patch = 'source.patch';
  writeFileSync(resolve(output, report.source_patch), execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repo }));
}
after(() => {
  writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Model route evidence: ${resolve(output, 'report.json')}`);
});

const REQUIRED = [
  'STADO_MODEL_ROUTER_URL',
  'WELES_STADO_MODEL_ROUTER_TOKEN',
  'WELES_STADO_MODEL_ROUTER_AGENT_ID',
  'WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET',
];

for (const name of REQUIRED) {
  assert.ok(
    typeof process.env[name] === 'string' && process.env[name].trim(),
    `${name} is required to drive a real model turn`,
  );
}

test('a single-turn decision is answered by the gateway for this agent’s alias', async () => {
  const routed = await callJeden('Reply with the single word ready.', { timeoutMs: 120_000 });
  report.observations.text = routed;
  assert.equal(routed.model, WELES_AGENT_MODEL, 'the turn was routed under a different model name');
  assert.match(routed.raw.toLowerCase(), /ready/);
});

test('a required function response is accepted without assistant text', async () => {
  const outputFunction = {
    name: 'confirm_ready',
    description: 'Confirm that this inference request is ready.',
    parameters: {
      type: 'object',
      properties: { ready: { type: 'boolean' } },
      required: ['ready'],
      additionalProperties: false,
    },
  };
  try {
    const result = await callJeden('Call confirm_ready with ready set to true. Do not write assistant text.', { outputFunction });
    report.observations.function_response = result;
    assert.equal(result.functionName, outputFunction.name);
    assert.deepEqual(JSON.parse(result.raw), { ready: true });
  } catch (error) {
    report.observations.function_failure = String(error);
    throw error;
  }
});

test('an image question reads the actual screenshot through an authorized visual route', async () => {
  const image = readFileSync(resolve(import.meta.dirname, 'fixtures/page.png'));
  report.input_sha256 = createHash('sha256').update(image).digest('hex');
  const health = await fetch(`${process.env.STADO_MODEL_ROUTER_URL}/health`, {
    headers: { authorization: `Bearer ${process.env.WELES_STADO_MODEL_ROUTER_TOKEN}` },
  });
  report.gateway_identity = { status: health.status, body: await health.json() };
  assert.equal(health.status, 200, 'the serving gateway identity is unavailable');
  try {
    const result = await callJeden('Read the large main heading in the attached image. Return only that heading.', {
      images: [image],
    });
    report.observations.image = result;
    assert.match(result.raw, /measuring\s+current\s+figma\s+components/i);
  } catch (error) {
    report.observations.image_failure = String(error);
    throw error;
  }
});

test('a refused turn reports the gateway’s own status and the alias it asked for', async () => {
  const token = process.env.WELES_STADO_MODEL_ROUTER_TOKEN;
  process.env.WELES_STADO_MODEL_ROUTER_TOKEN = 'x'.repeat(64);
  // The module caches its coordinates on first use, so the refusal is measured
  // in a fresh module instance rather than by mutating the cached one.
  const isolated = createRequire(import.meta.url);
  delete isolated.cache?.[resolve(import.meta.dirname, '../../dist/agent/jeden.js')];
  try {
    const fresh = require(resolve(import.meta.dirname, '../../dist/agent/jeden.js'));
    await assert.rejects(
      () => fresh.callJeden('Reply with the single word ready.', { timeoutMs: 60_000 }),
      (error) => {
        report.observations.authorization_refusal = String(error);
        assert.match(String(error.message), /model router (401|403)|invalid|unauthor/i);
        return true;
      },
    );
  } finally {
    process.env.WELES_STADO_MODEL_ROUTER_TOKEN = token;
  }
});
