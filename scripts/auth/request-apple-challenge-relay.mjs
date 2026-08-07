#!/usr/bin/env node

// Runs on the authorized external Weles host. It invokes a fixed, preconfigured
// command on the trusted Mac mini; that command captures the active Apple 2FA
// notification and relays the six digits directly to Skarbiec. No code returns
// through this process or stdout.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assertAppleAuthChallengeOpen, recordAppleAuthChallengeCaptured } from '../../dist/auth/apple-submit-guard.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,252}[A-Za-z0-9])?$/;
const SAFE_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const SAFE_REMOTE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const ALLOWED_FLAGS = new Set(['--guard-id', '--account-id', '--action-log-id']);

function flags(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!ALLOWED_FLAGS.has(name) || value === undefined || value.startsWith('--') || parsed.has(name)) {
      throw new Error(`Invalid Apple relay request flag: ${name ?? '(missing)'}`);
    }
    parsed.set(name, value);
  }
  return parsed;
}

function ownerOnlyFile(path, name) {
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`${name} must be an owner-only regular file`);
  }
  return path;
}

// Ask Stado which host currently holds the Apple account, instead of trusting a
// hand-written address.
//
// APPLE_2FA_MAC_HOST names a machine because someone believed, once, that it was the
// trusted device. Nothing re-checks that: an Apple account signs out on a password
// change and the variable keeps pointing at a Mac that will never show a prompt
// again, so the flow dies on the ssh timeout below instead of saying the binding is
// unsatisfied. `stado identity verify` probes the hosts and fails with the host to
// enroll, which turns that timeout into a sentence.
//
// The environment still wins when set, because an operator debugging one machine
// must be able to aim this by hand.
function resolveHolder(identity) {
  const stado = process.env.STADO_BIN ?? `${process.env.HOME ?? ''}/.local/bin/stado`;
  const result = spawnSync(stado, [
    'identity', 'verify', '--kind', 'apple-account', '--identity', identity, '--json',
  ], { encoding: 'utf8' });
  if (result.error || typeof result.stdout !== 'string') {
    throw new Error('Stado could not be asked which host holds the Apple account');
  }
  let report;
  try { report = JSON.parse(result.stdout); } catch {
    throw new Error('Stado returned an unreadable identity report');
  }
  if (!report || report.satisfied !== true || !Array.isArray(report.bindings)) {
    throw new Error(`no host holds apple-account ${identity}`);
  }
  // Only an observed holder may be used. A declared-but-unverified binding is the
  // exact state that produced the stale variable this function replaces.
  const holder = report.bindings.find((row) => row && row.observed === true
    && typeof row.ssh === 'string' && row.ssh.includes('@'));
  if (!holder) throw new Error(`no verified host holds apple-account ${identity}`);
  const [sshUser, sshHost] = holder.ssh.split('@');
  return { user: sshUser, host: sshHost };
}

const parsed = flags(process.argv.slice(2));
const guardId = (parsed.get('--guard-id') ?? '').toLowerCase();
const accountId = (parsed.get('--account-id') ?? '').toLowerCase();
const actionLogId = (parsed.get('--action-log-id') ?? '').toLowerCase();
for (const [name, value] of [['--guard-id', guardId], ['--account-id', accountId], ['--action-log-id', actionLogId]]) {
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a valid UUID`);
}

// An explicitly configured host wins; otherwise the holder is resolved from Stado,
// which is the only party that re-checks the binding.
const configuredHost = process.env.APPLE_2FA_MAC_HOST ?? '';
const resolved = configuredHost
  ? { host: configuredHost, user: process.env.APPLE_2FA_MAC_USER ?? '' }
  : resolveHolder(process.env.APPLE_2FA_ACCOUNT_IDENTITY ?? '');
const host = resolved.host;
const user = resolved.user;
const portText = process.env.APPLE_2FA_MAC_PORT ?? '';
const identityFile = ownerOnlyFile(process.env.APPLE_2FA_MAC_IDENTITY_FILE ?? '', 'APPLE_2FA_MAC_IDENTITY_FILE');
const knownHostsFile = ownerOnlyFile(process.env.APPLE_2FA_MAC_KNOWN_HOSTS_FILE ?? '', 'APPLE_2FA_MAC_KNOWN_HOSTS_FILE');
const remoteCommand = process.env.APPLE_2FA_MAC_RELAY_COMMAND ?? '';
if (!SAFE_HOST_PATTERN.test(host) || host.startsWith('-') || host.includes('..')) throw new Error('APPLE_2FA_MAC_HOST is invalid');
if (!SAFE_USER_PATTERN.test(user)) throw new Error('APPLE_2FA_MAC_USER is invalid');
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('APPLE_2FA_MAC_PORT is invalid');
if (!SAFE_REMOTE_PATH_PATTERN.test(remoteCommand) || remoteCommand.split('/').includes('..')) {
  throw new Error('APPLE_2FA_MAC_RELAY_COMMAND must be a safe absolute path');
}

await assertAppleAuthChallengeOpen(guardId, accountId, actionLogId);

const result = spawnSync('ssh', [
  '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${knownHostsFile}`, '-o', 'LogLevel=ERROR',
  '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=10', '-i', identityFile,
  '-p', String(port), '--', `${user}@${host}`, remoteCommand,
  '--guard-id', guardId,
], {
  cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 150_000,
  maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
if (result.error || result.status !== 0) throw new Error('Trusted Mac mini relay command failed closed');
let acknowledgement;
try { acknowledgement = JSON.parse(result.stdout); } catch { throw new Error('Trusted Mac mini relay returned invalid acknowledgement'); }
if (!acknowledgement || acknowledgement.status !== 'stored'
    || acknowledgement.resource !== `challenge:apple/${guardId}`) {
  throw new Error('Trusted Mac mini relay did not confirm the exact Apple challenge resource');
}
await recordAppleAuthChallengeCaptured(guardId, actionLogId);
console.log(JSON.stringify({ status: 'stored', resource: acknowledgement.resource }));
