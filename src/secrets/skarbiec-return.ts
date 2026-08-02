import { spawn } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const COMMAND_ENV = 'SKARBIEC_CREDENTIAL_RETURN_COMMAND';
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

type ReturnCredentialInput = {
  credentialId: string;
  requestId: string;
  provider: string;
  value: string;
};

type ReturnCredentialResult = {
  ok: boolean;
  status: string;
  credential: string;
  request_id: string;
};

function validateCredentialId(value: string): void {
  if (!/^[A-Z0-9_]{3,128}$/.test(value)) throw new Error('invalid Skarbiec credential id');
}

function validateRequestId(value: string): void {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('invalid Skarbiec request id');
}

function validateProvider(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('invalid Skarbiec provider');
}

async function checkedCommand(): Promise<string> {
  const configured = process.env[COMMAND_ENV]?.trim() ?? '';
  if (!configured) throw new Error(`${COMMAND_ENV} is not set`);
  if (!isAbsolute(configured)) throw new Error(`${COMMAND_ENV} must be an absolute path`);
  const link = await lstat(configured);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`${COMMAND_ENV} must name a regular, non-symlink file`);
  const metadata = await stat(configured);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`${COMMAND_ENV} must be owned by the current user`);
  }
  if ((metadata.mode & 0o022) !== 0 || (metadata.mode & 0o100) === 0) {
    throw new Error(`${COMMAND_ENV} must be owner-executable and not group/world-writable`);
  }
  return realpath(configured);
}

async function synchronizeVault(command: string, operation: 'sync-pull' | 'sync-push'): Promise<void> {
  if (!process.env.SKARBIEC_SYNC_DIR?.trim()) return;
  const response = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, [operation, ...(operation === 'sync-push' ? ['--message=weles credential return'] : [])], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`Skarbiec ${operation} failed`));
    };
    child.once('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RESPONSE_BYTES) {
        child.kill();
        fail();
        return;
      }
      output.push(chunk);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      settled = true;
      resolve(Buffer.concat(output));
    });
  });
  try {
    const parsed = JSON.parse(response.toString('utf8')) as { ok?: unknown };
    if (parsed.ok !== true) throw new Error();
  } catch {
    throw new Error(`Skarbiec ${operation} did not confirm synchronization`);
  }
}

async function registerCredentialRequest(command: string, input: ReturnCredentialInput): Promise<void> {
  const response = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, [
      'credential-request',
      input.credentialId,
      '--provider',
      input.provider,
      '--consumer',
      'weles',
      '--purpose',
      'Weles credential acquisition',
      '--request-id',
      input.requestId,
      '--register-only',
    ], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error('Skarbiec credential request registration failed'));
    };
    child.once('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RESPONSE_BYTES) {
        child.kill();
        fail();
        return;
      }
      output.push(chunk);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      settled = true;
      resolve(Buffer.concat(output));
    });
  });
  try {
    const parsed = JSON.parse(response.toString('utf8')) as {
      ok?: unknown;
      status?: unknown;
      credential?: unknown;
      request_id?: unknown;
    };
    if (
      parsed.ok !== true
      || parsed.status !== 'pending'
      || parsed.credential !== input.credentialId
      || parsed.request_id !== input.requestId
    ) throw new Error();
  } catch {
    throw new Error('Skarbiec did not confirm credential request registration');
  }
}

export async function returnCredentialToSkarbiec(input: ReturnCredentialInput): Promise<ReturnCredentialResult> {
  validateCredentialId(input.credentialId);
  validateRequestId(input.requestId);
  validateProvider(input.provider);
  if (!input.value || input.value.includes('\0') || Buffer.byteLength(input.value, 'utf8') > MAX_SECRET_BYTES) {
    throw new Error('invalid credential value');
  }
  const command = await checkedCommand();
  await synchronizeVault(command, 'sync-pull');
  await registerCredentialRequest(command, input);
  const args = [
    'credential-return',
    input.credentialId,
    '--request-id',
    input.requestId,
    '--provider',
    input.provider,
  ];

  const returned = await new Promise<ReturnCredentialResult>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once('error', () => fail(new Error('could not start Skarbiec credential return')));
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RESPONSE_BYTES) {
        child.kill();
        fail(new Error('Skarbiec credential return response exceeded size limit'));
        return;
      }
      output.push(chunk);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error('Skarbiec credential return failed'));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(output).toString('utf8')) as Partial<ReturnCredentialResult>;
        if (parsed.ok !== true || parsed.status !== 'ready' || parsed.credential !== input.credentialId || parsed.request_id !== input.requestId) {
          fail(new Error('Skarbiec credential return response did not match the request'));
          return;
        }
        settled = true;
        resolve(parsed as ReturnCredentialResult);
      } catch {
        fail(new Error('Skarbiec credential return response was not valid JSON'));
      }
    });
    child.stdin.once('error', () => fail(new Error('could not pipe credential to Skarbiec')));
    child.stdin.end(input.value, 'utf8');
  });
  await synchronizeVault(command, 'sync-push');
  return returned;
}
