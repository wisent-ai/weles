/**
 * The subscription pool, as Weles calls it.
 *
 * Brama replaced eleven per-audience inventory invocations with one capability
 * and deleted the routes the replaced ones served, so the three reauth runners
 * were calling GET, POST and DELETE /v1/subscriptions/:agent_id at a gateway
 * that answers none of them. This drives the real client the runners now use —
 * src/trajectories/_shared/subscription_pool.mjs, imported by codex, claude and
 * kimi — over real HTTP against a stub that answers with the pool document
 * Brama publishes.
 *
 * What this does NOT drive: a whole reauth tick. That reads its configuration
 * from the operator's vault through Skarbiec and, on a burnt pool, opens a
 * provider sign-in in a browser; neither belongs in a test, and this session may
 * touch neither. So the contract defended here is the request Weles sends and
 * the document it reads back, exercised for real, and nothing is claimed about
 * the login half.
 *
 * Run: node --test tests/pool/subscription-pool.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  SUBSCRIPTION_POOL_PATH,
  bankBody,
  listPool,
  retireBody,
  writePool,
} from '../../src/trajectories/_shared/subscription_pool.mjs';

/** The HMAC trio and bearer a reauth runner signs with, in the same shape. */
const HEADERS = Object.freeze({
  'x-agent-id': 'wisent-app',
  'x-agent-timestamp': '1757000000',
  'x-agent-signature': 'f'.repeat(64),
  'content-type': 'application/json',
  authorization: 'Bearer pool-bearer',
});

/** One row in the shape the pool publishes: the identity is `id`. */
const ROW = Object.freeze({
  id: 'sub-codex-primary',
  provider: 'codex',
  status: 'active',
  state: 'live',
  credential: { state: 'active' },
});

/** A stub of the pool: it records what it was asked and answers the document. */
async function poolStub(answer) {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      const { status, payload } = answer(request.method, body);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((closed) => server.close(closed)),
  };
}

test('the pool listing is one signed GET on the pool path, and its rows carry id', async () => {
  const stub = await poolStub(() => ({
    status: 200,
    payload: { ok: true, observed_at_ms: 1757000000000, scope: 'wisent-app', errors: [], subscriptions: [ROW] },
  }));
  try {
    const response = await listPool(stub.baseUrl, HEADERS);
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.equal(document.ok, true);
    assert.equal(document.scope, 'wisent-app');
    assert.deepEqual(document.subscriptions.map((row) => row.id), ['sub-codex-primary']);

    assert.equal(stub.seen.length, 1);
    assert.equal(stub.seen[0].method, 'GET');
    assert.equal(stub.seen[0].url, SUBSCRIPTION_POOL_PATH);
    assert.equal(stub.seen[0].url, '/v1/subscription-pool');
    // The identity contract is unchanged by the move.
    assert.equal(stub.seen[0].headers['x-agent-id'], 'wisent-app');
    assert.equal(stub.seen[0].headers['x-agent-signature'], 'f'.repeat(64));
    assert.equal(stub.seen[0].headers.authorization, 'Bearer pool-bearer');
  } finally {
    await stub.close();
  }
});

test('banking a credential is a POST naming the action, and never the agent', async () => {
  const stub = await poolStub(() => ({
    status: 200,
    payload: { subscription: { id: ROW.id, provider: 'codex', agent_id: 'wisent-app', status: 'active' } },
  }));
  try {
    const payload = bankBody({
      provider: 'codex',
      label: 'codex-reauth Wisent 2026-09-07T00:00:00.000Z',
      api_key: '{"tokens":{"id_token":"x"}}',
      login_item: 'weles-codex-wisent-account',
    });
    const response = await writePool(stub.baseUrl, HEADERS, payload);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).subscription.id, ROW.id);

    const sent = JSON.parse(stub.seen[0].body);
    assert.equal(stub.seen[0].method, 'POST');
    assert.equal(stub.seen[0].url, '/v1/subscription-pool');
    assert.equal(sent.action, 'bank');
    assert.equal(sent.provider, 'codex');
    assert.equal(sent.login_item, 'weles-codex-wisent-account');
    // The pool derives the owner from the proof and refuses a body that names
    // it: `agent_id is derived from the proven identity and must not be sent`.
    assert.equal('agent_id' in sent, false);
    // The signature covers these exact bytes, so the body on the wire is the
    // string the caller signed.
    assert.equal(stub.seen[0].body, payload);
  } finally {
    await stub.close();
  }
});

test('retiring a subscription is the same POST with the action and the row id', async () => {
  const stub = await poolStub(() => ({ status: 200, payload: { ok: true } }));
  try {
    const payload = retireBody(ROW.id);
    const response = await writePool(stub.baseUrl, HEADERS, payload);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);

    const sent = JSON.parse(stub.seen[0].body);
    assert.equal(stub.seen[0].method, 'POST');
    assert.equal(stub.seen[0].url, '/v1/subscription-pool');
    assert.deepEqual(sent, { action: 'retire', subscription_id: ROW.id });
    assert.equal('agent_id' in sent, false);
  } finally {
    await stub.close();
  }
});

test('a refused write is reported by the pool, not swallowed here', async () => {
  // The runners decide what an unhappy status means, so the client must hand
  // the refusal back rather than translate it.
  const stub = await poolStub(() => ({
    status: 404,
    payload: { error: { code: 'not_found', message: 'subscription not found' } },
  }));
  try {
    const response = await writePool(stub.baseUrl, HEADERS, retireBody('sub-nobody-owns'));
    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
    assert.equal((await response.json()).error.message, 'subscription not found');
  } finally {
    await stub.close();
  }
});
