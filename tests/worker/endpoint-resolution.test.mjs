#!/usr/bin/env node

import assert from 'node:assert';
import * as net from 'node:net';
import { isEndpointListening, resolveSkarbiecEndpoint, formatEndpointErrorMessage } from '../../src/worker/deploy/endpoint-resolution.mjs';

let testsPassed = 0;
let testsFailed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
    testsFailed++;
  }
}

async function startTestServer(port) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const server = net.createServer(() => {});
  server.listen(port, '127.0.0.1', () => resolve(server));
  server.on('error', reject);
  return promise;
}

async function stopTestServer(server) {
  await server.close();
}

// Tests
await test('isEndpointListening: detects listening endpoint', async () => {
  const server = await startTestServer(9001);
  try {
    const result = await isEndpointListening('http://127.0.0.1:9001', 2000);
    assert.strictEqual(result, true);
  } finally {
    await stopTestServer(server);
  }
});

await test('isEndpointListening: detects unreachable endpoint', async () => {
  const result = await isEndpointListening('http://127.0.0.1:9999', 500);
  assert.strictEqual(result, false);
});

await test('isEndpointListening: handles invalid URLs gracefully', async () => {
  const result = await isEndpointListening('not-a-valid-url', 500);
  assert.strictEqual(result, false);
});

await test('resolveSkarbiecEndpoint: live directory endpoint is used', async () => {
  const server = await startTestServer(9003);
  const originalEnv = process.env.WC_SKARBIEC_URL;
  try {
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9003';
    
    const result = await resolveSkarbiecEndpoint();
    assert.ok(result.resolved);
    assert.strictEqual(result.resolved.url, 'http://127.0.0.1:9003');
    assert.strictEqual(result.resolved.isListening, true);
  } finally {
    if (originalEnv) process.env.WC_SKARBIEC_URL = originalEnv;
    else delete process.env.WC_SKARBIEC_URL;
    await stopTestServer(server);
  }
});

await test('resolveSkarbiecEndpoint: dead directory endpoint is not redirected', async () => {
  const originalEnv = process.env.WC_SKARBIEC_URL;
  try {
    // A dead directory endpoint must remain the only endpoint.
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9999';
    
    const result = await resolveSkarbiecEndpoint();
    // It must not fall back to any marker or built-in address.
    assert.ok(result.resolved);
    assert.strictEqual(result.resolved.url, 'http://127.0.0.1:9999');
    assert.strictEqual(result.resolved.isListening, false);
  } finally {
    if (originalEnv) process.env.WC_SKARBIEC_URL = originalEnv;
    else delete process.env.WC_SKARBIEC_URL;
  }
});

await test('resolveSkarbiecEndpoint: missing directory endpoint refuses implicit routing', async () => {
  delete process.env.WC_SKARBIEC_URL;

  const result = await resolveSkarbiecEndpoint();
  assert.strictEqual(result.resolved, null);
});

await test('resolveSkarbiecEndpoint: directory-supplied WC_SKARBIEC_URL is resolved', async () => {
  const server = await startTestServer(9008);
  const originalEnv = process.env.WC_SKARBIEC_URL;
  try {
    // The exact directory-supplied value is the only candidate.
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9008';
    
    const result = await resolveSkarbiecEndpoint();
    assert.ok(result.resolved);
    assert.strictEqual(result.resolved.url, 'http://127.0.0.1:9008', 'must use exact directory value');
    assert.strictEqual(result.resolved.isListening, true, 'must detect listening');
  } finally {
    if (originalEnv) process.env.WC_SKARBIEC_URL = originalEnv;
    else delete process.env.WC_SKARBIEC_URL;
    await stopTestServer(server);
  }
});

await test('formatEndpointErrorMessage: formats correctly', async () => {
  const info = {
    url: 'http://127.0.0.1:8785',
    isListening: false,
  };
  
  const msg = formatEndpointErrorMessage(info);
  assert.match(msg, /Skarbiec endpoint at http:\/\/127\.0\.0\.1:8785/);
  assert.match(msg, /Stado service directory/);
  assert.match(msg, /not listening/);
});

// Report results
console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
