import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { humanFill } from '../src/human/keyboard.js';
import { wsFillCredential } from '../src/session/wsession-helpers/finalize.js';

vi.mock('../src/human/keyboard.js', () => ({
  humanFill: vi.fn(),
  humanType: vi.fn(),
}));
import {
  assertCapability,
  redeemCapability,
  withCapability,
  type CapabilityRef,
} from '../src/utils/capability.js';

const CAPABILITY_ID = 'a'.repeat(64);
const PURPOSE = 'weles.browser.fill';
const RESOURCE = 'origin:https://example.test/password';
const PROOF_DOMAIN = Buffer.from('SKARBIEC-WORKLOAD-PROOF\0v1\0', 'utf8');
const originalEnv = { ...process.env };

let tempDir: string;
let socketPath: string;
let publicKey: KeyObject;
let server: Server | undefined;
let sockets: Set<Socket>;
let acceptedConnections: number;

function validCapability(): CapabilityRef {
  return { capability_id: CAPABILITY_ID, purpose: PURPOSE, resource: RESOURCE, target: 'weles' };
}

function credentialSession(pageUrl = 'https://example.test/login?return=%2Faccount') {
  const locator = { isVisible: vi.fn().mockResolvedValue(true) };
  const runStep = vi.fn();
  const capture = vi.fn();
  const saveDom = vi.fn();
  const pageScreenshot = vi.fn();
  const session = {
    page: {
      url: () => pageUrl,
      frames: () => [],
      getByLabel: vi.fn(() => ({ first: () => locator })),
      screenshot: pageScreenshot,
    },
    resolveEnv: (value: string) => value,
    runStep,
    screenshot: capture,
    _cap: { screenshot: capture },
    _saveDom: saveDom,
  };
  return { session, locator, runStep, capture, saveDom, pageScreenshot };
}

async function startBroker(respond: (request: Buffer, socket: Socket) => void): Promise<void> {
  server = createServer({ allowHalfOpen: true }, (socket) => {
    acceptedConnections += 1;
    sockets.add(socket);
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once('end', () => respond(Buffer.concat(chunks), socket));
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(socketPath, resolve);
  });
}

beforeEach(() => {
  process.env = { ...originalEnv };
  tempDir = mkdtempSync(join(tmpdir(), 'weles-capability-test-'));
  socketPath = join(tempDir, 'broker.sock');
  sockets = new Set<Socket>();
  acceptedConnections = 0;

  const pair = generateKeyPairSync('ed25519');
  publicKey = pair.publicKey;
  const keyPath = join(tempDir, 'workload-key.pem');
  writeFileSync(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });

  process.env.SKARBIEC_WORKLOAD_ID = 'weles-test-worker';
  process.env.SKARBIEC_WORKLOAD_SIGNING_KEY_FILE = keyPath;
  process.env.SKARBIEC_CAP_SOCKET = socketPath;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  if (server?.listening) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
  rmSync(tempDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('typed Weles capabilities', () => {
  it.each([
    { name: 'non-Weles target', ref: { ...validCapability(), target: 'most' }, error: 'invalid capability reference' },
    { name: 'different purpose', ref: { ...validCapability(), purpose: 'weles.captcha.solve', resource: 'provider:captcha.example.test' }, error: 'capability operation mismatch' },
    { name: 'different resource', ref: { ...validCapability(), resource: 'origin:https://example.test/email' }, error: 'capability operation mismatch' },
  ])('rejects a $name before opening the redemption socket', async ({ ref, error }) => {
    await startBroker((_request, socket) => socket.end());

    await expect(withCapability(ref as CapabilityRef, { purpose: PURPOSE, resource: RESOURCE }, async () => 'used'))
      .rejects.toThrow(error);
    expect(acceptedConnections).toBe(0);
  });

  it.each([
    { name: 'uppercase hex', capability_id: 'A'.repeat(64) },
    { name: '63 hex characters', capability_id: 'a'.repeat(63) },
    { name: 'non-hex character', capability_id: `${'a'.repeat(63)}g` },
  ])('rejects a capability id with $name', ({ capability_id }) => {
    expect(() => assertCapability({ ...validCapability(), capability_id }, { purpose: PURPOSE, resource: RESOURCE }))
      .toThrow('invalid capability reference');
  });

  it.each([
    { name: 'raw plaintext string', ref: 'legacy-plaintext-secret' },
    { name: 'legacy secret object', ref: { ...validCapability(), secret: 'legacy-plaintext-secret' } },
    { name: 'unknown authority field', ref: { ...validCapability(), audience: 'weles' } },
  ])('rejects a $name without a legacy redemption bypass', async ({ ref }) => {
    await startBroker((_request, socket) => socket.end());

    await expect(withCapability(
      ref as unknown as CapabilityRef,
      { purpose: PURPOSE, resource: RESOURCE },
      async () => 'used',
    )).rejects.toThrow('invalid capability reference');
    expect(acceptedConnections).toBe(0);
  });

  it.each([
    {
      name: 'relative broker socket',
      configure: () => { process.env.SKARBIEC_CAP_SOCKET = 'broker.sock'; },
      error: 'SKARBIEC_CAP_SOCKET must be absolute',
    },
    {
      name: 'group-readable signing key',
      configure: () => { chmodSync(process.env.SKARBIEC_WORKLOAD_SIGNING_KEY_FILE!, 0o640); },
      error: 'workload signing key must be an owner-only regular file',
    },
    {
      name: 'signing-key directory',
      configure: () => { process.env.SKARBIEC_WORKLOAD_SIGNING_KEY_FILE = tempDir; },
      error: 'workload signing key must be an owner-only regular file',
    },
  ])('rejects $name before opening the local broker connection', async ({ configure, error }) => {
    await startBroker((_request, socket) => socket.end());
    configure();

    await expect(redeemCapability(CAPABILITY_ID)).rejects.toThrow(error);
    expect(acceptedConnections).toBe(0);
  });
});

describe('wsFillCredential final-use boundary', () => {
  it('rejects a capability for another resource before redeeming or touching the credential field', async () => {
    const { session, runStep, capture, saveDom, pageScreenshot } = credentialSession();
    vi.mocked(humanFill).mockClear();
    await startBroker((_request, socket) => socket.end());

    await expect(wsFillCredential(
      session as never,
      'Password',
      'password',
      { ...validCapability(), resource: 'origin:https://example.test/email' },
    )).rejects.toThrow('capability operation mismatch');

    expect(acceptedConnections).toBe(0);
    expect(humanFill).not.toHaveBeenCalled();
    expect(runStep).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(saveDom).not.toHaveBeenCalled();
    expect(pageScreenshot).not.toHaveBeenCalled();
  });

  it('never exposes a redeemed credential to a cross-origin child frame', async () => {
    const rawSecret = 'origin-bound-final-use-secret';
    const pageUrl = 'https://accounts.example.test/login';
    const capability = { ...validCapability(), resource: 'origin:https://accounts.example.test/password' };
    const { session, locator: mainLocator } = credentialSession(pageUrl);
    const mainFrame = { url: () => pageUrl };
    const evilLocator = { isVisible: vi.fn().mockResolvedValue(true) };
    const evilGetByLabel = vi.fn(() => evilLocator);
    const evilFrame = { url: () => 'https://evil.example/embedded', getByLabel: evilGetByLabel };
    Object.assign(session.page, {
      mainFrame: () => mainFrame,
      frames: () => [mainFrame, evilFrame],
    });
    vi.mocked(humanFill).mockClear();
    await startBroker((_request, socket) => {
      socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'ok', secret_len: Buffer.byteLength(rawSecret) })}\n${rawSecret}`);
    });

    const result = await wsFillCredential(session as never, 'Password', 'password', capability);

    expect(result).toBe('credential filled');
    expect(evilGetByLabel).not.toHaveBeenCalled();
    expect(humanFill).toHaveBeenCalledOnce();
    expect(humanFill).toHaveBeenCalledWith(session.page, mainLocator, rawSecret);
  });

  it('redeems for the current origin and field class only at the final fill without leaking secret material', async () => {
    const rawSecret = 'vault-secret-ws-fill-final-use';
    const pageUrl = 'https://accounts.example.test:8443/login?return=%2Faccount';
    const capability = { ...validCapability(), resource: 'origin:https://accounts.example.test:8443/api-key' };
    const { session, locator, runStep, capture, saveDom, pageScreenshot } = credentialSession(pageUrl);
    vi.mocked(humanFill).mockClear();
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    await startBroker((_request, socket) => {
      socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'ok', secret_len: Buffer.byteLength(rawSecret) })}\n${rawSecret}`);
    });

    const result = await wsFillCredential(session as never, 'API key', 'api-key', capability);

    expect(result).toBe('credential filled');
    expect(humanFill).toHaveBeenCalledOnce();
    expect(humanFill).toHaveBeenCalledWith(session.page, locator, rawSecret);
    expect(runStep).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(saveDom).not.toHaveBeenCalled();
    expect(pageScreenshot).not.toHaveBeenCalled();
    const consoleOutput = consoleSpies.flatMap((spy) => spy.mock.calls).flat().map(String).join('\n');
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(result)).not.toContain(CAPABILITY_ID);
    expect(consoleOutput).not.toContain(rawSecret);
    expect(consoleOutput).not.toContain(CAPABILITY_ID);
  });
});

describe('skarbiec.redeem.v1 wire contract', () => {
  it('sends one newline-delimited signed request through EOF and returns the exact framed secret bytes', async () => {
    const secret = Buffer.from([0x00, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74, 0xff]);
    const requests: Buffer[] = [];
    await startBroker((request, socket) => {
      requests.push(request);
      const control = Buffer.from(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'ok', secret_len: secret.length })}\n`);
      socket.end(Buffer.concat([control, secret]));
    });

    const redeemed = await redeemCapability(CAPABILITY_ID);

    expect(redeemed).toEqual(secret);
    expect(requests).toHaveLength(1);
    expect(acceptedConnections).toBe(1);
    const request = requests[0];
    expect(request[request.length - 1]).toBe(0x0a);
    expect(request.indexOf(0x0a)).toBe(request.length - 1);

    const control = JSON.parse(request.subarray(0, -1).toString('utf8')) as Record<string, string>;
    expect(control).toEqual({
      version: 'skarbiec.redeem.v1',
      operation: 'redeem',
      capability_id: CAPABILITY_ID,
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      workload_id: 'weles-test-worker',
      proof: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/),
    });
    const signed = Buffer.concat([
      PROOF_DOMAIN,
      Buffer.from(CAPABILITY_ID, 'ascii'), Buffer.from([0]),
      Buffer.from(control.nonce, 'ascii'), Buffer.from([0]),
      Buffer.from(control.workload_id, 'utf8'), Buffer.from([0]),
      Buffer.from(control.operation, 'ascii'), Buffer.from([0]),
    ]);
    expect(verify(null, signed, publicKey, Buffer.from(control.proof, 'base64url'))).toBe(true);
  });

  it.each([
    {
      name: 'success body ends before secret_len',
      expected: 'invalid broker success framing',
      respond: (socket: Socket) => socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'ok', secret_len: 20 })}\nvault-secret`),
    },
    {
      name: 'success body contains bytes beyond secret_len',
      expected: 'invalid broker success framing',
      respond: (socket: Socket) => socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'ok', secret_len: 6 })}\nvault-secret`),
    },
    {
      name: 'broker denies the capability',
      expected: 'capability denied',
      respond: (socket: Socket) => socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'denied' })}\n`),
    },
    {
      name: 'denial control includes secret framing',
      expected: 'invalid broker denied framing',
      respond: (socket: Socket) => socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'denied', secret_len: 0 })}\n`),
    },
    {
      name: 'broker returns an unknown status',
      expected: 'invalid broker status',
      respond: (socket: Socket) => socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'retry' })}\n`),
    },
    {
      name: 'control line has no newline terminator',
      expected: 'invalid broker control line',
      respond: (socket: Socket) => socket.end(JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'denied' })),
    },
    {
      name: 'control line contains carriage return',
      expected: 'invalid broker control line',
      respond: (socket: Socket) => socket.end('{"version":"skarbiec.redeem.v1","status":"denied"}\r\n'),
    },
    {
      name: 'control line is malformed JSON',
      expected: 'invalid broker control JSON',
      respond: (socket: Socket) => socket.end('{"version":\n'),
    },
    {
      name: 'success control contains an unknown field',
      expected: 'invalid broker success framing',
      respond: (socket: Socket) => socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'ok', secret_len: 1, resource: RESOURCE })}\nx`),
    },
    {
      name: 'denial includes a body',
      expected: 'invalid broker denied framing',
      respond: (socket: Socket) => socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'denied' })}\nlegacy-plaintext-secret`),
    },
  ])('fails closed when $name', async ({ expected, respond }) => {
    await startBroker((_request, socket) => respond(socket));

    const error = await redeemCapability(CAPABILITY_ID).then(
      () => new Error('redemption unexpectedly succeeded'),
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(expected);
    expect(String(error)).not.toContain('vault-secret');
  });

  it('returns only the consumer result and zeroes redeemed bytes after final use', async () => {
    const rawSecret = 'vault-secret-final-use';
    const secretBuffers: Buffer[] = [];
    const originalFill = Buffer.prototype.fill;
    vi.spyOn(Buffer.prototype, 'fill').mockImplementation(function (value) {
      if (this.toString('utf8') === rawSecret) secretBuffers.push(this);
      return originalFill.call(this, value);
    });
    await startBroker((_request, socket) => {
      socket.end(`${JSON.stringify({ version: 'skarbiec.redeem.v1', status: 'ok', secret_len: Buffer.byteLength(rawSecret) })}\n${rawSecret}`);
    });

    const result = await withCapability(validCapability(), { purpose: PURPOSE, resource: RESOURCE }, async (secret) => ({
      accepted: secret === rawSecret,
    }));

    expect(result).toEqual({ accepted: true });
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(secretBuffers.length).toBeGreaterThan(0);
    for (const buffer of secretBuffers) expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true);
  });
});
