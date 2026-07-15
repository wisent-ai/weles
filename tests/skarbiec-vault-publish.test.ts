import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishReturnedSkarbiecVault } from '../src/secrets/skarbiec-vault-publish.js';

const baseEnv = { ...process.env };
const roots: string[] = [];

afterEach(async () => {
  process.env = { ...baseEnv };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('returned Skarbiec vault publication', () => {
  it('uploads an immutable encrypted vault asset for the request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weles-vault-publish-'));
    roots.push(root);
    const vault = join(root, 'skarbiec.vault.json');
    const credentials = join(root, 'git-credentials');
    const vaultBytes = Buffer.from('encrypted-vault-ciphertext');
    await writeFile(vault, vaultBytes);
    await writeFile(credentials, 'https://worker:github-token-canary@github.com\n');
    await chmod(vault, 0o600);
    await chmod(credentials, 0o600);
    process.env.SKARBIEC_PUBLISH_VAULT_AFTER_RETURN = '1';
    process.env.SKARBIEC_VAULT_FILE = vault;
    process.env.SKARBIEC_CRED_FILE = credentials;
    process.env.SKARBIEC_WELES_REPO = 'wisent-ai/weles';
    const requestId = 'c'.repeat(64);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/releases/tags/')) {
        return new Response(JSON.stringify({ id: 123, assets: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 456 }), { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await publishReturnedSkarbiecVault(requestId);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/wisent-ai/weles/releases/tags/skarbiec-vault-latest');
    expect(calls[1]?.url).toBe(`https://uploads.github.com/repos/wisent-ai/weles/releases/123/assets?name=skarbiec.vault.${requestId}.json`);
    expect(calls[1]?.init?.method).toBe('POST');
    expect(calls[1]?.init?.headers).toMatchObject({
      Authorization: 'Bearer github-token-canary',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(vaultBytes.length),
    });
    expect(Buffer.from(calls[1]?.init?.body as Uint8Array)).toEqual(vaultBytes);
  });
});
