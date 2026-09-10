// The Skarbiec capability broker transport: the proof this workload signs,
// the socket it speaks on, and the one request shape - redeem or cancel -
// the broker answers. The purpose and resource checks that decide whether a
// capability may be asked for at all stay in `../capability.ts`.

import { randomBytes, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createConnection } from 'node:net';

export const CAPABILITY_RE = /^[0-9a-f]{64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_LIMIT = 1024 * 1024;
const CONTROL_LIMIT = 4096;
const PROOF_DOMAIN = Buffer.from('SKARBIEC-WORKLOAD-PROOF\0v1\0', 'utf8');

export class CapabilityPendingError extends Error {
  readonly code = 'CAPABILITY_PENDING';

  constructor(message = 'capability material is pending') {
    super(message);
    this.name = 'CapabilityPendingError';
  }
}

export function requiredConfig(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value) throw new Error(`invalid ${name}`);
  return value;
}

function signingKey(): Buffer {
  const path = requiredConfig('SKARBIEC_WORKLOAD_SIGNING_KEY_FILE');
  if (!isAbsolute(path)) throw new Error('SKARBIEC_WORKLOAD_SIGNING_KEY_FILE must be absolute');
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('workload signing key must be an owner-only regular file');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('workload signing key owner mismatch');
  return readFileSync(path);
}

function brokerSocket(): string {
  const path = requiredConfig('SKARBIEC_CAP_SOCKET');
  if (!isAbsolute(path)) throw new Error('SKARBIEC_CAP_SOCKET must be absolute');
  return path;
}

export async function requestCapability(
  capabilityId: string,
  operation: 'redeem' | 'cancel',
  authorizationId?: string,
): Promise<Buffer> {
  if (!CAPABILITY_RE.test(capabilityId)) throw new Error('invalid capability id');
  if (authorizationId !== undefined && !UUID_RE.test(authorizationId)) throw new Error('invalid capability authorization id');
  const workloadId = requiredConfig('SKARBIEC_WORKLOAD_ID');
  if (workloadId.length > 128 || /[\u0000\r\n]/.test(workloadId)) throw new Error('invalid SKARBIEC_WORKLOAD_ID');
  const nonce = randomBytes(32).toString('base64url');
  const message = Buffer.concat([
    PROOF_DOMAIN,
    Buffer.from(capabilityId, 'ascii'), Buffer.from([0]),
    Buffer.from(nonce, 'ascii'), Buffer.from([0]),
    Buffer.from(workloadId, 'utf8'), Buffer.from([0]),
    Buffer.from(operation, 'ascii'), Buffer.from([0]),
    Buffer.from(authorizationId ?? '', 'ascii'),
  ]);
  const key = signingKey();
  let proof: string;
  try {
    proof = sign(null, message, key).toString('base64url');
  } finally {
    key.fill(0);
    message.fill(0);
  }
  if (proof.length !== 86) throw new Error('invalid workload proof length');
  const requestRecord: Record<string, unknown> = {
    version: 'skarbiec.redeem.v1',
    operation,
    capability_id: capabilityId,
    nonce,
    workload_id: workloadId,
    proof,
  };
  if (authorizationId !== undefined) requestRecord.authorization_id = authorizationId;
  const request = Buffer.from(`${JSON.stringify(requestRecord)}\n`, 'utf8');
  proof = '';

  const { promise, resolve, reject } = (Promise as typeof Promise & {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }).withResolvers<Buffer>();
  {
    const chunks: Buffer[] = [];
    let total = 0;
    let ended = false;
    let settled = false;
    const socketPath = brokerSocket();
    const socket = createConnection({ path: socketPath });
    socket.setTimeout(10_000);
    const wipe = () => {
      request.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      wipe();
      socket.destroy();
      reject(error);
    };
    socket.once('connect', () => { socket.end(request); request.fill(0); });
    socket.on('data', (chunk: Buffer) => {
      if (settled) { chunk.fill(0); return; }
      total += chunk.length;
      if (total > RESPONSE_LIMIT + CONTROL_LIMIT) { chunk.fill(0); fail(new Error('broker response oversized')); return; }
      chunks.push(chunk);
    });
    socket.once('timeout', () => fail(new Error('broker response missing EOF')));
    // The cause used to be discarded here, and `broker transport failure`
    // cannot be acted on: ENOENT means no broker ever bound this path,
    // ECONNREFUSED means the file outlived the process that bound it, and
    // EACCES means the socket belongs to another account. Three different
    // repairs behind one sentence, which is how a Developer ID run spent an
    // afternoon being diagnosed as the wrong problem.
    socket.once('error', (error: NodeJS.ErrnoException) => fail(
      new Error(`broker transport failure: ${error.code ?? error.message} at ${socketPath}`),
    ));
    socket.once('end', () => { ended = true; });
    socket.once('close', (hadError) => {
      if (settled || hadError) return;
      if (!ended) { fail(new Error('broker response truncated')); return; }
      const response = Buffer.concat(chunks, total);
      wipe();
      const rejectResponse = (message: string) => {
        response.fill(0);
        settled = true;
        reject(new Error(message));
      };
      const newline = response.indexOf(0x0a);
      if (newline < 1 || newline > CONTROL_LIMIT || response.subarray(0, newline).includes(0x0d)) {
        rejectResponse('invalid broker control line'); return;
      }
      let control: unknown;
      try { control = JSON.parse(response.subarray(0, newline).toString('utf8')); }
      catch { rejectResponse('invalid broker control JSON'); return; }
      if (!control || typeof control !== 'object' || Array.isArray(control)) {
        rejectResponse('invalid broker control object'); return;
      }
      const record = control as Record<string, unknown>;
      if (record.version !== 'skarbiec.redeem.v1') { rejectResponse('broker version mismatch'); return; }
      const body = response.subarray(newline + 1);
      if (record.status === 'denied' || record.status === 'pending') {
        if (Object.keys(record).some((key) => !['version', 'status'].includes(key)) || body.length !== 0) {
          rejectResponse(`invalid broker ${String(record.status)} framing`); return;
        }
        if (record.status === 'pending') {
          response.fill(0);
          settled = true;
          reject(new CapabilityPendingError());
          return;
        }
        rejectResponse('capability denied'); return;
      }
      if (record.status !== 'ok') { rejectResponse('invalid broker status'); return; }
      if (Object.keys(record).some((key) => !['version', 'status', 'secret_len'].includes(key))
        || !Number.isSafeInteger(record.secret_len) || (record.secret_len as number) < 0
        || record.secret_len !== body.length) {
        rejectResponse('invalid broker success framing'); return;
      }
      const secret = Buffer.from(body);
      response.fill(0);
      settled = true;
      resolve(secret);
    });
  }
  return await promise;
}
