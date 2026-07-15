import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { returnCredentialToSkarbiec } from '../src/secrets/skarbiec-return.js';

const originalCommand = process.env.SKARBIEC_CREDENTIAL_RETURN_COMMAND;
const roots: string[] = [];

afterEach(async () => {
  if (originalCommand === undefined) delete process.env.SKARBIEC_CREDENTIAL_RETURN_COMMAND;
  else process.env.SKARBIEC_CREDENTIAL_RETURN_COMMAND = originalCommand;
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
await writeFile(${JSON.stringify(capture)}, JSON.stringify({ args, stdin: Buffer.concat(chunks).toString('utf8') }));
console.log(JSON.stringify({ ok: true, status: 'ready', credential, request_id: requestId }));
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
});
