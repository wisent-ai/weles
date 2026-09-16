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
const { askLlm, parseJsonFrom } = require(resolve(import.meta.dirname, '../../dist/agent/loop/observe.js'));
const { askJedenAboutImage } = require(resolve(import.meta.dirname, '../../dist/vision/analyze.js'));
const repo = resolve(import.meta.dirname, '../..');
const output = resolve(repo, '.wisent-output', 'model-route-tests', randomUUID());
mkdirSync(output, { recursive: true });
process.env.WELES_VISION_DIR = resolve(output, 'vision');
const report = {
  source_revision: process.env.WISENT_SOURCE_COMMIT
    || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  compiled_sha256: Object.fromEntries(['agent/jeden', 'agent/model/message', 'agent/tools', 'agent/loop/observe', 'vision/analyze'].map(name => [
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
process.once('exit', code => {
  report.exit_code = code;
  writeFileSync(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
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

test('the browser planner emits an executable observed-link action through its actual tool catalog', async () => {
  const target = '[6] a label=version-pinned export workflow href=https://www.wisent.com/docs/components/figma-export';
  try {
    const decision = await askLlm(
      'Open the version-pinned export workflow by clicking its observed link. Preserve the complete observed target, including its index. Do not navigate directly or finish before the click.',
      `CURRENT URL: https://www.wisent.com/docs/components/figma-measurement\nCONTROLS:\n${target}\nACTION HISTORY:\nNo actions yet.`,
      null, 0, undefined,
      async (prompt, options) => {
        const routed = await callJeden(prompt, options);
        report.observations.browser_function_response = routed;
        return routed;
      },
      true,
    );
    report.observations.browser_decision = decision;
    assert.equal(decision.tool, 'click');
    assert.deepEqual(decision.args, { target });
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

test('a detailed screenshot question distinguishes visible facts from content below the viewport', async () => {
  // Actual failed viewport from dedicated-host run a6d52764-a049-40ef-86bd-a500bdcbb74e.
  const image = readFileSync(resolve(import.meta.dirname, 'fixtures/scrolled-page.png'));
  report.scrolled_input_sha256 = createHash('sha256').update(image).digest('hex');
  const question = 'Read the measurement command, incomplete-measurement exit code, unresolved-identifier meaning, recorded source revision, and export-link href from the screenshot. Return only JSON with fields measurement_command (string), incomplete_exit_code (number), unresolved_proves_absence (boolean), source_revision (string or null), export_href (string or null). Use null when the revision or href is not visible; do not infer it.';
  try {
    const answer = await askJedenAboutImage(image, question, 'tier_0_bare');
    const originalQuestion = "Read the rendered heading at the top of the page and the measurement command beginning 'node src/cli.mjs figma-variables --components', the saved-result and recorded-result sections (nonzero exit behavior, unresolved identifiers, source revision, statement about not proving visual parity), and identify the visible 'version-pinned export workflow' link including its href attribute value.";
    const originalAnswer = await askJedenAboutImage(image, originalQuestion, 'tier_0_bare');
    report.observations.original_scrolled_question = { question: originalQuestion, answer: originalAnswer };
    assert.match(originalAnswer, /node src\/cli\.mjs figma-variables --components --only iyYN8q8ZJMRy6oSKjjQIYo/);
    report.observations.scrolled_image = { question, answer };
    const facts = parseJsonFrom(answer);
    assert.equal(facts.measurement_command, 'node src/cli.mjs figma-variables --components --only iyYN8q8ZJMRy6oSKjjQIYo');
    assert.equal(facts.incomplete_exit_code, 1);
    assert.equal(facts.unresolved_proves_absence, false);
    assert.equal(facts.source_revision, null);
    assert.equal(facts.export_href, null);
  } catch (error) {
    report.observations.scrolled_image_failure = String(error);
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
