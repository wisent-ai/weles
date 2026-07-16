import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { returnCredentialToSkarbiec } from '../src/secrets/skarbiec-return.js';

const originalCommand = process.env.SKARBIEC_CREDENTIAL_RETURN_COMMAND;
const originalSyncDirectory = process.env.SKARBIEC_SYNC_DIR;
const roots: string[] = [];

beforeEach(() => {
  delete process.env.SKARBIEC_SYNC_DIR;
});

afterEach(async () => {
  if (originalCommand === undefined) delete process.env.SKARBIEC_CREDENTIAL_RETURN_COMMAND;
  else process.env.SKARBIEC_CREDENTIAL_RETURN_COMMAND = originalCommand;
  if (originalSyncDirectory === undefined) delete process.env.SKARBIEC_SYNC_DIR;
  else process.env.SKARBIEC_SYNC_DIR = originalSyncDirectory;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Skarbiec credential return transport', () => {
  it('passes the key only on stdin and verifies the bound response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weles-skarbiec-return-'));
    roots.push(root);
    const capture = join(root, 'capture.json');
    const command = join(root, 'fake-skarbiec.mjs');
    await writeFile(command, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const args = process.argv.slice(2);
const credential = args[1];
const requestId = args[args.indexOf('--request-id') + 1];
if (args[0] === 'credential-request') {
  console.log(JSON.stringify({ ok: true, status: 'pending', credential, request_id: requestId }));
} else {
  await writeFile(${JSON.stringify(capture)}, JSON.stringify({ args, stdin: Buffer.concat(chunks).toString('utf8') }));
  console.log(JSON.stringify({ ok: true, status: 'ready', credential, request_id: requestId }));
}
`);
    await chmod(command, 0o700);
    process.env.SKARBIEC_CREDENTIAL_RETURN_COMMAND = command;
    const requestId = 'b'.repeat(64);
    const secret = 'brave-canary-stdin-only-key';

    const result = await returnCredentialToSkarbiec({
      credentialId: 'BRAVE_SEARCH_API_KEY',
      requestId,
      provider: 'brave',
      value: secret,
    });

    expect(result).toEqual({
      ok: true,
      status: 'ready',
      credential: 'BRAVE_SEARCH_API_KEY',
      request_id: requestId,
    });
    const captured = JSON.parse(await readFile(capture, 'utf8')) as { args: string[]; stdin: string };
    expect(captured.stdin).toBe(secret);
    expect(JSON.stringify(captured.args)).not.toContain(secret);
    expect(captured.args).toEqual([
      'credential-return',
      'BRAVE_SEARCH_API_KEY',
      '--request-id',
      requestId,
      '--provider',
      'brave',
    ]);
  });
  it('pulls before credential return and pushes only after Skarbiec confirms storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weles-skarbiec-sync-'));
    roots.push(root);
    const capture = join(root, 'operations.jsonl');
    const command = join(root, 'fake-skarbiec.mjs');
    await writeFile(command, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
await appendFile(${JSON.stringify(capture)}, JSON.stringify({ operation: args[0], stdinBytes: Buffer.concat(chunks).length }) + '\\n');
if (args[0] === 'sync-pull' || args[0] === 'sync-push') {
  console.log(JSON.stringify({ ok: true }));
} else if (args[0] === 'credential-request') {
  console.log(JSON.stringify({ ok: true, status: 'pending', credential: args[1], request_id: args[args.indexOf('--request-id') + 1] }));
} else {
  console.log(JSON.stringify({ ok: true, status: 'ready', credential: args[1], request_id: args[args.indexOf('--request-id') + 1] }));
}
`);
    await chmod(command, 0o700);
    process.env.SKARBIEC_CREDENTIAL_RETURN_COMMAND = command;
    process.env.SKARBIEC_SYNC_DIR = root;

    await returnCredentialToSkarbiec({
      credentialId: 'SUPABASE_ACCESS_TOKEN',
      requestId: 'c'.repeat(64),
      provider: 'supabase',
      value: 'sbp_sync_order_canary',
    });

    const operations = (await readFile(capture, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { operation: string; stdinBytes: number });
    expect(operations).toEqual([
      { operation: 'sync-pull', stdinBytes: 0 },
      { operation: 'credential-request', stdinBytes: 0 },
      { operation: 'credential-return', stdinBytes: 21 },
      { operation: 'sync-push', stdinBytes: 0 },
    ]);
  });

});
