import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callJeden } from '../src/agent/loop.js';

describe('agent loop Jeden adapter', () => {
  let root = '';

  afterEach(() => {
    delete process.env.BRAMA_URL;
    delete process.env.WISENT_APP_AGENT_ID;
    delete process.env.WISENT_APP_AGENT_AUTH_SECRET;
    delete process.env.WELES_AGENT_MODEL;
    delete process.env.WELES_JEDEN_BIN;
    delete process.env.WELES_JEDEN_SESSION_ROOT;
    delete process.env.WELES_JEDEN_TEST_CAPTURE;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('invokes Jeden in model-only mode and passes Brama credentials only through the environment', async () => {
    root = mkdtempSync(join(tmpdir(), 'weles-jeden-test-'));
    const capturePath = join(root, 'capture.json');
    const fakeJeden = join(root, 'jeden');
    writeFileSync(fakeJeden, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.WELES_JEDEN_TEST_CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  bramaUrl: process.env.BRAMA_URL,
  agentId: process.env.WISENT_APP_AGENT_ID,
  hmacSecret: process.env.WISENT_APP_AGENT_AUTH_SECRET,
  sessionRoot: process.env.JEDEN_SESSION_ROOT,
}));
process.stdout.write(JSON.stringify({ ok: true, text: '{"tool":"done","args":{"value":"ok"}}' }));
`);
    chmodSync(fakeJeden, 0o700);
    process.env.BRAMA_URL = 'https://router.example.test/';
    process.env.WISENT_APP_AGENT_ID = 'agent-test';
    process.env.WISENT_APP_AGENT_AUTH_SECRET = 'secret-test';
    process.env.WELES_AGENT_MODEL = 'openai-primary';
    process.env.WELES_JEDEN_BIN = fakeJeden;
    process.env.WELES_JEDEN_SESSION_ROOT = join(root, 'sessions');
    process.env.WELES_JEDEN_TEST_CAPTURE = capturePath;

    const result = await callJeden('choose next browser action');
    const captured = JSON.parse(readFileSync(capturePath, 'utf8')) as {
      args: string[];
      bramaUrl: string;
      agentId: string;
      hmacSecret: string;
      sessionRoot: string;
    };

    expect(captured.args).toEqual([
      'run',
      'choose next browser action',
      '--json',
      '--model-only',
      '--model',
      'openai-primary',
      '--max-steps',
      '1',
      '--cwd',
      process.cwd(),
    ]);
    expect(captured.args).not.toContain('secret-test');
    expect(captured).toMatchObject({
      bramaUrl: 'https://router.example.test',
      agentId: 'agent-test',
      hmacSecret: 'secret-test',
      sessionRoot: join(root, 'sessions'),
    });
    expect(result).toEqual({
      raw: '{"tool":"done","args":{"value":"ok"}}',
      model: 'openai-primary',
      routerUrl: 'https://router.example.test',
    });
  });
});
