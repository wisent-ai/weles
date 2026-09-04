import { test } from 'node:test';
import * as assert from 'node:assert';
import * as net from 'node:net';

import {
  isEndpointListening,
  resolveSkarbiecEndpoint,
  formatEndpointErrorMessage,
  EndpointInfo,
} from '../dist/utils/endpoint-resolution.js';

async function startTestServer(port: number): Promise<net.Server> {
  const { promise, resolve, reject } = Promise.withResolvers<net.Server>();
  const server = net.createServer(() => {
    // Accept connections but do nothing - we just need to listen
  });
  server.listen(port, '127.0.0.1', () => {
    resolve(server);
  });
  server.on('error', reject);
  return promise;
}

async function stopTestServer(server: net.Server): Promise<void> {
  await server.close();
}

test('isEndpointListening: detects listening endpoint', async () => {
  const server = await startTestServer(9001);
  try {
    const isListening = await isEndpointListening('http://127.0.0.1:9001', 2000);
    assert.ok(isListening, 'should detect that endpoint is listening');
  } finally {
    await stopTestServer(server);
  }
});

test('isEndpointListening: detects unreachable endpoint', async () => {
  const isListening = await isEndpointListening('http://127.0.0.1:9999', 500);
  assert.ok(!isListening, 'should detect that endpoint is not listening');
});

test('isEndpointListening: handles invalid URLs gracefully', async () => {
  const isListening = await isEndpointListening('not-a-valid-url', 500);
  assert.ok(!isListening, 'should return false for invalid URL');
});

test('isEndpointListening: extracts port from URL correctly', async () => {
  const server = await startTestServer(9002);
  try {
    let isListening = await isEndpointListening('http://127.0.0.1:9002', 2000);
    assert.ok(isListening, 'should work with explicit port');

    isListening = await isEndpointListening('https://127.0.0.1:9999', 500);
    assert.ok(!isListening, 'should parse HTTPS URL correctly');
  } finally {
    await stopTestServer(server);
  }
});

test('resolveSkarbiecEndpoint: respects WC_SKARBIEC_URL environment variable', async () => {
  const server = await startTestServer(9003);
  const originalEnv = process.env.WC_SKARBIEC_URL;

  try {
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9003';
    delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;

    const result = await resolveSkarbiecEndpoint();
    assert.ok(result.resolved, 'should resolve an endpoint');
    assert.strictEqual(result.resolved?.url, 'http://127.0.0.1:9003', 'should use env variable');
    assert.strictEqual(result.resolved?.source, 'environment', 'should mark as from environment');
    assert.ok(result.resolved?.isListening, 'should detect listening server');
  } finally {
    if (originalEnv) {
      process.env.WC_SKARBIEC_URL = originalEnv;
    } else {
      delete process.env.WC_SKARBIEC_URL;
    }
    await stopTestServer(server);
  }
});


test('resolveSkarbiecEndpoint: refuses implicit routing when no directory endpoint is exported', async () => {
  const originalWcUrl = process.env.WC_SKARBIEC_URL;

  try {
    delete process.env.WC_SKARBIEC_URL;

    const result = await resolveSkarbiecEndpoint();
    assert.strictEqual(result.resolved, null);
    assert.deepStrictEqual(result.candidates, []);
    assert.strictEqual(result.wasExplicitOverride, false);
  } finally {
    if (originalWcUrl) {
      process.env.WC_SKARBIEC_URL = originalWcUrl;
    }
  }
});

test('resolveSkarbiecEndpoint: retains the declared endpoint when it is unavailable', async () => {
  const originalEnv = process.env.WC_SKARBIEC_URL;

  try {
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9999';

    const result = await resolveSkarbiecEndpoint();
    assert.ok(result.resolved, 'should retain the declared endpoint');
    assert.strictEqual(result.resolved?.url, 'http://127.0.0.1:9999',
      'should retain the exact directory-derived endpoint');
    assert.ok(!result.resolved?.isListening, 'should indicate that endpoint is not listening');
  } finally {
    if (originalEnv) {
      process.env.WC_SKARBIEC_URL = originalEnv;
    } else {
      delete process.env.WC_SKARBIEC_URL;
    }
  }
});

test('formatEndpointErrorMessage: formats environment source correctly', async () => {
  const info: EndpointInfo = {
    url: 'http://127.0.0.1:8785',
    source: 'environment',
    sourceDetail: 'WC_SKARBIEC_URL environment variable',
    isListening: false,
  };

  const message = formatEndpointErrorMessage(info);
  assert.match(message, /Skarbiec endpoint at http:\/\/127\.0\.0\.1:8785/, 'should include endpoint URL');
  assert.match(message, /environment variable/, 'should indicate environment source');
  assert.match(message, /not listening/, 'should indicate listening status');
});


test('formatEndpointErrorMessage: indicates listening status', async () => {
  const listeningInfo: EndpointInfo = {
    url: 'http://127.0.0.1:8785',
    source: 'environment',
    sourceDetail: 'WC_SKARBIEC_URL environment variable',
    isListening: true,
  };

  const listeningMessage = formatEndpointErrorMessage(listeningInfo);
  assert.match(listeningMessage, /listening/, 'should indicate listening for healthy endpoint');

  const deadInfo: EndpointInfo = {
    url: 'http://127.0.0.1:8785',
    source: 'environment',
    sourceDetail: 'WC_SKARBIEC_URL environment variable',
    isListening: false,
  };

  const deadMessage = formatEndpointErrorMessage(deadInfo);
  assert.match(deadMessage, /not listening/, 'should indicate not listening for dead endpoint');
});
