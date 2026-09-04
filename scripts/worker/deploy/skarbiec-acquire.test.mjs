#!/usr/bin/env node

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as net from 'node:net';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

function createTestScopeFile() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'weles-test-'));
  const scopeFile = join(tmpDir, 'scopes.conf');
  writeFileSync(scopeFile, `test-consumer|test-item|test-field\n`);
  return { tmpDir, scopeFile };
}

function cleanupScopeFile(tmpDir) {
  rmSync(tmpDir, { recursive: true, force: true });
}

// The acquisition helper accepts only the directory-resolved four-argument form.
await test('skarbiec-acquire: new 4-arg form parsed correctly (no usage error)', async () => {
  const server = await startTestServer(9010);
  const { tmpDir, scopeFile } = createTestScopeFile();
  const originalEnv = process.env.WC_SKARBIEC_URL;
  
  try {
    process.env.WC_SKARBIEC_URL = 'http://127.0.0.1:9010';
    delete process.env.WELES_CREDENTIAL_SKARBIEC_URL;
    
    const result = spawnSync('node', [
      'scripts/worker/deploy/skarbiec-acquire.mjs',
      scopeFile,
      'test-consumer',
      'test-item',
      'test-field'
    ], {
      cwd: '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles',
      encoding: 'utf8'
    });
    
    // Should NOT have usage error - endpoint resolution should happen
    const output = (result.stderr || result.stdout || '');
    assert.ok(!output.includes('usage:'), `Should not fail on arg parsing, got: ${output}`);
  } finally {
    if (originalEnv) process.env.WC_SKARBIEC_URL = originalEnv;
    else delete process.env.WC_SKARBIEC_URL;
    await stopTestServer(server);
    cleanupScopeFile(tmpDir);
  }
});


await test('skarbiec-acquire: rejects invalid arg counts', async () => {
  const result = spawnSync('node', [
    'scripts/worker/deploy/skarbiec-acquire.mjs',
    'arg1',
    'arg2'
  ], {
    cwd: '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles',
    encoding: 'utf8'
  });
  
  const output = result.stderr || result.stdout || '';
  assert.match(output, /usage:/, `Should show usage error, got: ${output}`);
});

// Report results
console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
process.exit(testsFailed > 0 ? 1 : 0);
