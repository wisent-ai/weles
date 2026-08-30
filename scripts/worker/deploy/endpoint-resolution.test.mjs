#!/usr/bin/env node

import assert from 'node:assert';
import * as net from 'node:net';
import { homedir } from 'node:os';
import { isEndpointListening, resolveSkarbiecEndpoint, formatEndpointErrorMessage } from './endpoint-resolution.mjs';

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

await test('resolveSkarbiecEndpoint: explicit alive override is used', async () => {
  const server = await startTestServer(9003);
  const originalEnv = process.env.WC_SKARBIEC_URL;
  try {
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9003';
    delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;
    
    const result = await resolveSkarbiecEndpoint();
    assert.ok(result.resolved);
    assert.strictEqual(result.resolved.url, 'http://127.0.0.1:9003');
    assert.strictEqual(result.resolved.source, 'environment');
    assert.strictEqual(result.resolved.isListening, true);
    assert.strictEqual(result.wasExplicitOverride, true);
  } finally {
    if (originalEnv) process.env.WC_SKARBIEC_URL = originalEnv;
    else delete process.env.WC_SKARBIEC_URL;
    await stopTestServer(server);
  }
});

await test('resolveSkarbiecEndpoint: explicit dead override returned (not silently redirected)', async () => {
  const originalEnv = process.env.WC_SKARBIEC_URL;
  try {
    // Set explicit override to dead port - should NOT fall back
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9999';
    delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;
    
    const result = await resolveSkarbiecEndpoint();
    // Should resolve to the dead endpoint (not fall back to marker or default)
    assert.ok(result.resolved);
    assert.strictEqual(result.resolved.url, 'http://127.0.0.1:9999');
    assert.strictEqual(result.resolved.source, 'environment');
    assert.strictEqual(result.resolved.isListening, false);
    assert.strictEqual(result.wasExplicitOverride, true);
  } finally {
    if (originalEnv) process.env.WC_SKARBIEC_URL = originalEnv;
    else delete process.env.WC_SKARBIEC_URL;
  }
});

await test('resolveSkarbiecEndpoint: no explicit includes built-in default as last resort', async () => {
  delete process.env.WC_SKARBIEC_URL;
  delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;
  
  const result = await resolveSkarbiecEndpoint();
  const hasDefault = result.candidates.some(c => c.url === 'http://127.0.0.1:8895');
  assert.ok(hasDefault, 'should include built-in default');
  assert.strictEqual(
    result.candidates[result.candidates.length - 1].url,
    'http://127.0.0.1:8895',
    'default should be last'
  );
  assert.strictEqual(result.wasExplicitOverride, false);
});

await test('formatEndpointErrorMessage: formats correctly', async () => {
  const info = {
    url: 'http://127.0.0.1:8785',
    source: 'environment',
    sourceDetail: 'WC_SKARBIEC_URL environment variable',
    isListening: false,
  };
  
  const msg = formatEndpointErrorMessage(info);
  assert.match(msg, /Skarbiec endpoint at http:\/\/127\.0\.0\.1:8785/);
  assert.match(msg, /environment variable/);
  assert.match(msg, /not listening/);
});

// Report results
console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
