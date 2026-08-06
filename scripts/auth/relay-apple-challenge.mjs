#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { captureAppleNativeTwoFactor } from '../trajectories/apple/native_2fa/native_2fa.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NATIVE_CHALLENGE_WAIT_MS = 120_000;
const SAFE_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,252}[A-Za-z0-9])?$/;
const SAFE_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const SAFE_REMOTE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const ALLOWED_FLAGS = new Set([
  '--guard-id',
  '--ssh-host',
  '--ssh-user',
  '--ssh-port',
  '--ssh-identity-file',
  '--ssh-known-hosts-file',
  '--remote-skarbiec-command',
]);

function usage() {
  console.error(
    'Usage: node scripts/auth/relay-apple-challenge.mjs '
    + '--guard-id <uuid> --ssh-host <host> --ssh-user <user> --ssh-port <port> '
    + '--ssh-identity-file <absolute-path> --ssh-known-hosts-file <absolute-path> '
    + '--remote-skarbiec-command <absolute-path>',
  );
}

function parseFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!ALLOWED_FLAGS.has(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid or incomplete flag: ${name ?? '(missing)'}`);
    }
    if (flags.has(name)) throw new Error(`Duplicate flag: ${name}`);
    flags.set(name, value);
  }
  return flags;
}

function requireRegularFile(path, name, ownerOnly) {
  if (/[\u0000\r\n]/.test(path)) throw new Error(`${name} contains forbidden control characters`);
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${name} must name a regular file`);
  if (ownerOnly && (stat.mode & 0o077) !== 0) throw new Error(`${name} must be owner-only`);
  if (ownerOnly && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${name} owner mismatch`);
  }
  return path;
}

function configuration(flags) {
  const guardId = (flags.get('--guard-id') ?? '').toLowerCase();
  const host = flags.get('--ssh-host') ?? process.env.APPLE_2FA_SKARBIEC_HOST ?? '';
  const user = flags.get('--ssh-user') ?? process.env.APPLE_2FA_SKARBIEC_USER ?? '';
  const portText = flags.get('--ssh-port') ?? process.env.APPLE_2FA_SKARBIEC_PORT ?? '';
  const identityFile = flags.get('--ssh-identity-file') ?? process.env.APPLE_2FA_SKARBIEC_IDENTITY_FILE ?? '';
  const knownHostsFile = flags.get('--ssh-known-hosts-file') ?? process.env.APPLE_2FA_SKARBIEC_KNOWN_HOSTS_FILE ?? '';
  const skarbiecCommand = flags.get('--remote-skarbiec-command') ?? process.env.APPLE_2FA_SKARBIEC_COMMAND ?? '';

  if (!UUID_PATTERN.test(guardId)) throw new Error('--guard-id must be a valid UUID');
  if (!SAFE_HOST_PATTERN.test(host) || host.startsWith('-') || host.includes('..')) {
    throw new Error('--ssh-host is invalid');
  }
  if (!SAFE_USER_PATTERN.test(user)) throw new Error('--ssh-user is invalid');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--ssh-port must be an integer from 1 to 65535');
  requireRegularFile(identityFile, '--ssh-identity-file', true);
  requireRegularFile(knownHostsFile, '--ssh-known-hosts-file', true);
  if (!SAFE_REMOTE_PATH_PATTERN.test(skarbiecCommand) || skarbiecCommand.split('/').includes('..')) {
    throw new Error('--remote-skarbiec-command must be a safe absolute path');
  }
  return { guardId, host, user, port, identityFile, knownHostsFile, skarbiecCommand };
}

function sshArguments(config, resource) {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.knownHostsFile}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectionAttempts=1',
    '-o', 'ConnectTimeout=10',
    '-i', config.identityFile,
    '-p', String(config.port),
    '--', `${config.user}@${config.host}`,
    config.skarbiecCommand,
    'apple-challenge-put',
    resource,
  ];
}

function sixDigitCode(path) {
  const captured = readFileSync(path);
  let code = null;
  try {
    const contentLength = captured.length === 7 && captured[6] === 0x0a ? 6 : captured.length;
    if (contentLength !== 6) throw new Error('Native helper produced an invalid Apple challenge code');
    for (let index = 0; index < 6; index += 1) {
      if (captured[index] < 0x30 || captured[index] > 0x39) {
        throw new Error('Native helper produced an invalid Apple challenge code');
      }
    }
    code = Buffer.alloc(6);
    captured.copy(code, 0, 0, 6);
    return code;
  } finally {
    captured.fill(0);
    if (code?.length !== 6) code?.fill(0);
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Apple challenge relay requires macOS');
  const config = configuration(parseFlags(process.argv.slice(2)));
  const resource = `challenge:apple/${config.guardId}`;
  const tempDirectory = mkdtempSync(join(tmpdir(), 'weles-apple-challenge-'));
  chmodSync(tempDirectory, 0o700);
  const codeFile = join(tempDirectory, 'code');
  let code = null;
  try {
    const deadline = Date.now() + NATIVE_CHALLENGE_WAIT_MS;
    let capture = null;
    let allowClicked = false;
    while (Date.now() < deadline) {
      capture = captureAppleNativeTwoFactor({
        codeFile,
        clickAllow: !allowClicked,
        clickDone: true,
        timeoutMs: 30_000,
      });
      allowClicked ||= capture.clickedAllow === true;
      if (capture.codeCaptured && capture.outputFile === codeFile) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!capture?.codeCaptured || capture.outputFile !== codeFile) {
      throw new Error('Timed out waiting for the native Apple challenge code');
    }
    code = sixDigitCode(codeFile);
    rmSync(codeFile, { force: true });

    const result = spawnSync('ssh', sshArguments(config, resource), {
      cwd: process.cwd(),
      env: process.env,
      input: code,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) throw new Error('Remote Apple challenge store failed closed');

    let acknowledgement;
    try {
      acknowledgement = JSON.parse(result.stdout);
    } catch {
      throw new Error('Remote Apple challenge store returned invalid JSON');
    }
    if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)
      || Object.keys(acknowledgement).sort().join(',') !== 'resource,status'
      || acknowledgement.status !== 'stored'
      || acknowledgement.resource !== resource) {
      throw new Error('Remote Apple challenge store did not acknowledge the exact resource');
    }
    console.log(JSON.stringify({ status: 'stored', resource }));
  } finally {
    code?.fill(0);
    rmSync(codeFile, { force: true });
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Apple challenge relay failed closed');
  usage();
  process.exitCode = 1;
}
