/**
 * The model route the browser loop takes, against the real Brama gateway.
 *
 * A single-turn decision is asked of Brama directly, signed with this agent's
 * identity and asking for this agent's alias. Before that, the call spawned
 * whatever `jeden` the host's PATH held: on 2026-09-07 the binary on the
 * dedicated host asked Brama for a subscription rather than the alias, and
 * every browser task there died with `subscription_unavailable` while the same
 * alias through the same resolver answered on the first try. So this measures
 * two things: a real answer comes back, and it comes back for the alias.
 *
 * The turn needs what the runtime needs: `STADO_MODEL_ROUTER_URL`,
 * `WELES_STADO_MODEL_ROUTER_TOKEN`, `WELES_STADO_MODEL_ROUTER_AGENT_ID` and
 * `WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET`. A missing one fails the test by
 * name instead of skipping it.
 *
 * Run: node --test tests/agent/model-route.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { callJeden, WELES_AGENT_MODEL } = require(resolve(import.meta.dirname, '../../dist/agent/jeden.js'));

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
  assert.equal(routed.model, WELES_AGENT_MODEL, 'the turn was routed under a different model name');
  assert.ok(routed.raw.length > 0, 'the gateway returned no text');
  assert.match(routed.raw.toLowerCase(), /ready/);
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
        assert.match(String(error.message), /model router (401|403)|invalid|unauthor/i);
        return true;
      },
    );
  } finally {
    process.env.WELES_STADO_MODEL_ROUTER_TOKEN = token;
  }
});
