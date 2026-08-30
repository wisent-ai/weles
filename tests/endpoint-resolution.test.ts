import { test } from 'tap';
import * as net from 'node:net';
import { homedir } from 'node:os';

import {
  isEndpointListening,
  resolveSkarbiecEndpoint,
  formatEndpointErrorMessage,
  EndpointInfo,
} from '../src/utils/endpoint-resolution.js';

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

test('isEndpointListening: detects listening endpoint', async (t) => {
  const server = await startTestServer(9001);
  try {
    const isListening = await isEndpointListening('http://127.0.0.1:9001', 2000);
    t.ok(isListening, 'should detect that endpoint is listening');
  } finally {
    await stopTestServer(server);
  }
});

test('isEndpointListening: detects unreachable endpoint', async (t) => {
  // Use a port that's very unlikely to be listening
  const isListening = await isEndpointListening('http://127.0.0.1:9999', 500);
  t.notOk(isListening, 'should detect that endpoint is not listening');
});

test('isEndpointListening: handles invalid URLs gracefully', async (t) => {
  const isListening = await isEndpointListening('not-a-valid-url', 500);
  t.notOk(isListening, 'should return false for invalid URL');
});

test('isEndpointListening: extracts port from URL correctly', async (t) => {
  const server = await startTestServer(9002);
  try {
    // Test with explicit port
    let isListening = await isEndpointListening('http://127.0.0.1:9002', 2000);
    t.ok(isListening, 'should work with explicit port');

    // Test with HTTPS default port (would fail to connect, but should parse correctly)
    isListening = await isEndpointListening('https://127.0.0.1:9999', 500);
    t.notOk(isListening, 'should parse HTTPS URL correctly');
  } finally {
    await stopTestServer(server);
  }
});

test('resolveSkarbiecEndpoint: respects WC_SKARBIEC_URL environment variable', async (t) => {
  const server = await startTestServer(9003);
  const originalEnv = process.env.WC_SKARBIEC_URL;

  try {
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9003';
    delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;

    const result = await resolveSkarbiecEndpoint();
    t.ok(result.resolved, 'should resolve an endpoint');
    t.equal(result.resolved?.url, 'http://127.0.0.1:9003', 'should use env variable');
    t.equal(result.resolved?.source, 'environment', 'should mark as from environment');
    t.ok(result.resolved?.isListening, 'should detect listening server');
  } finally {
    if (originalEnv) {
      process.env.WC_SKARBIEC_URL = originalEnv;
    } else {
      delete process.env.WC_SKARBIEC_URL;
    }
    await stopTestServer(server);
  }
});

test('resolveSkarbiecEndpoint: prefers WELES_CREDENTIAL_SKARBIEC_URL over default', async (t) => {
  const server = await startTestServer(9004);
  const originalEnv = process.env.WELES_CREDENTIAL_SKARBIEC_URL;

  try {
    delete process.env.WC_SKARBIEC_URL;
    process.env.WELES_CREDENTIAL_SKARBIEC_URL = 'http://127.0.0.1:9004';

    const result = await resolveSkarbiecEndpoint();
    t.ok(result.resolved, 'should resolve an endpoint');
    t.equal(result.resolved?.url, 'http://127.0.0.1:9004', 'should use WELES_CREDENTIAL_SKARBIEC_URL');
    t.equal(result.resolved?.source, 'environment', 'should mark as from environment');
  } finally {
    if (originalEnv) {
      process.env.WELES_CREDENTIAL_SKARBIEC_URL = originalEnv;
    } else {
      delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;
    }
    await stopTestServer(server);
  }
});

test('resolveSkarbiecEndpoint: includes built-in default as fallback', async (t) => {
  const originalEnv = process.env.WC_SKARBIEC_URL;

  try {
    delete process.env.WC_SKARBIEC_URL;
    delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;

    const result = await resolveSkarbiecEndpoint();
    t.ok(result.candidates.some((c) => c.url === 'http://127.0.0.1:8895'),
      'should include built-in default in candidates');
    t.equal(
      result.candidates[result.candidates.length - 1].url,
      'http://127.0.0.1:8895',
      'built-in default should be last in candidates'
    );
  } finally {
    if (originalEnv) {
      process.env.WC_SKARBIEC_URL = originalEnv;
    }
  }
});

test('resolveSkarbiecEndpoint: prefers listening endpoint over dead one', async (t) => {
  const originalEnv = process.env.WC_SKARBIEC_URL;

  try {
    // Set env to a dead endpoint
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9999';
    delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;

    // Start a server on the default port
    const defaultServer = await startTestServer(8895);

    try {
      const result = await resolveSkarbiecEndpoint();
      t.ok(result.resolved, 'should resolve an endpoint');
      // Should prefer the default (listening) over the env var (dead)
      t.equal(result.resolved?.url, 'http://127.0.0.1:8895',
        'should prefer listening default over dead env endpoint');
      t.ok(result.resolved?.isListening, 'resolved endpoint should be listening');
    } finally {
      await stopTestServer(defaultServer);
    }
  } finally {
    if (originalEnv) {
      process.env.WC_SKARBIEC_URL = originalEnv;
    }
  }
});

test('resolveSkarbiecEndpoint: returns first candidate if none listening', async (t) => {
  const originalEnv = process.env.WC_SKARBIEC_URL;

  try {
    // Set env to a dead endpoint that will be checked first
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9999';
    delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;

    const result = await resolveSkarbiecEndpoint();
    t.ok(result.resolved, 'should still resolve even if nothing is listening');
    t.equal(result.resolved?.url, 'http://127.0.0.1:9999',
      'should return first candidate when none listening');
    t.notOk(result.resolved?.isListening, 'should indicate that endpoint is not listening');
  } finally {
    if (originalEnv) {
      process.env.WC_SKARBIEC_URL = originalEnv;
    }
  }
});

test('formatEndpointErrorMessage: formats environment source correctly', async (t) => {
  const info: EndpointInfo = {
    url: 'http://127.0.0.1:8785',
    source: 'environment',
    sourceDetail: 'WC_SKARBIEC_URL environment variable',
    isListening: false,
  };

  const message = formatEndpointErrorMessage(info);
  t.match(message, /Skarbiec endpoint at http:\/\/127\.0\.0\.1:8785/, 'should include endpoint URL');
  t.match(message, /environment variable/, 'should indicate environment source');
  t.match(message, /not listening/, 'should indicate listening status');
});

test('formatEndpointErrorMessage: formats forward marker source correctly', async (t) => {
  const info: EndpointInfo = {
    url: 'http://127.0.0.1:8895',
    source: 'forward-marker',
    sourceDetail: `${homedir()}/.stado/forwards/skarbiec.local`,
    isListening: false,
  };

  const message = formatEndpointErrorMessage(info);
  t.match(message, /Skarbiec endpoint/, 'should indicate Skarbiec endpoint');
  t.match(message, /forward marker/, 'should indicate forward marker source');
  t.match(message, /\.stado\/forwards/, 'should include path');
});

test('formatEndpointErrorMessage: indicates listening status', async (t) => {
  const listeningInfo: EndpointInfo = {
    url: 'http://127.0.0.1:8895',
    source: 'default',
    sourceDetail: 'built-in default',
    isListening: true,
  };

  const listeningMessage = formatEndpointErrorMessage(listeningInfo);
  t.match(listeningMessage, /listening/, 'should indicate listening for healthy endpoint');

  const deadInfo: EndpointInfo = {
    url: 'http://127.0.0.1:8785',
    source: 'default',
    sourceDetail: 'built-in default',
    isListening: false,
  };

  const deadMessage = formatEndpointErrorMessage(deadInfo);
  t.match(deadMessage, /not listening/, 'should indicate not listening for dead endpoint');
});
