#!/usr/bin/env node

// Runs on the authorized external Weles host. It asks Stado which machine currently
// holds the Apple account, then runs one installed helper there through the registry
// channel; that helper captures the active Apple 2FA notification and relays the six
// digits directly to Skarbiec. No code returns through this process or stdout.

import { spawnSync } from 'node:child_process';
import { assertAppleAuthChallengeOpen, recordAppleAuthChallengeCaptured } from '../../dist/auth/apple-submit-guard.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

// Ask Stado which host currently holds the Apple account, instead of trusting a
// hand-written address.
//
// APPLE_2FA_MAC_HOST named a machine because someone believed, once, that it was the
// trusted device. Nothing re-checked that: an Apple account signs out on a password
// change and the variable keeps pointing at a Mac that will never show a prompt
// again, so the flow died on a connection timeout instead of saying the binding is
// unsatisfied. `stado identity verify` probes the hosts and names the host to enroll,
// which turns that timeout into a sentence.
//
// What comes back is the registry's name for the machine, not an address: the channel
// that runs the helper resolves the target itself, so an address here would be a
// second way to say where a host is, and the one that goes stale.
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
    && typeof row.host === 'string' && row.host);
  if (!holder) throw new Error(`no verified host holds apple-account ${identity}`);
  return holder.host;
}

const parsed = flags(process.argv.slice(2));
const guardId = (parsed.get('--guard-id') ?? '').toLowerCase();
const accountId = (parsed.get('--account-id') ?? '').toLowerCase();
const actionLogId = (parsed.get('--action-log-id') ?? '').toLowerCase();
for (const [name, value] of [['--guard-id', guardId], ['--account-id', accountId], ['--action-log-id', actionLogId]]) {
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a valid UUID`);
}

// Reaching the holder is Stado's job, not this script's.
//
// This used to open its own ssh connection, carrying a private key file, a private
// known_hosts, a port and an absolute remote path -- six environment variables
// describing a channel that exists nowhere in the registry. That is the same action
// with the audit trail removed: nothing recorded who reached which machine to capture
// a two-factor code, and the hand-written address is exactly what went stale. `stado
// host run-helper` reaches the same machine through the channel the fleet already
// authenticates, logs and owns.
//
// The helper is a basename under the target's owner-only Stado directory and the
// guard id travels as a UUID, which is the only argument shape that channel carries.
// Nothing here can name a path on the remote machine any more. The deadline is left
// to Stado, which already bounds the helper: two timeouts for one call would only
// disagree about which of them ended it.
//
// The helper basename and the target name are validated by Stado, which owns both:
// it resolves the target against the registry and refuses a helper name that is not a
// safe basename. Re-checking them here would be a second opinion that can only drift
// from the one actually enforced.
const helper = process.env.APPLE_2FA_RELAY_HELPER ?? 'apple-challenge-capture';
const host = resolveHolder(process.env.APPLE_2FA_ACCOUNT_IDENTITY ?? '');

await assertAppleAuthChallengeOpen(guardId, accountId, actionLogId);

const stado = process.env.STADO_BIN ?? `${process.env.HOME ?? ''}/.local/bin/stado`;
const result = spawnSync(stado, [
  'host', 'run-helper', host, helper, '--uuid', guardId, '--json',
], { cwd: process.cwd(), env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (result.error || result.status) throw new Error('Trusted Mac relay command failed closed');
let report;
try { report = JSON.parse(result.stdout); } catch { throw new Error('Stado returned an unreadable relay report'); }
if (!report || report.status !== 'completed') {
  throw new Error('Stado reported the trusted Mac relay helper did not complete');
}
let acknowledgement;
try { acknowledgement = JSON.parse(report.stdout); } catch { throw new Error('Trusted Mac relay returned invalid acknowledgement'); }
if (!acknowledgement || acknowledgement.status !== 'stored'
    || acknowledgement.resource !== `challenge:apple/${guardId}`) {
  throw new Error('Trusted Mac relay did not confirm the exact Apple challenge resource');
}
await recordAppleAuthChallengeCaptured(guardId, actionLogId);
console.log(JSON.stringify({ status: 'stored', resource: acknowledgement.resource }));
