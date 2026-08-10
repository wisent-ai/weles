#!/usr/bin/env node

// Runs on the authorized external Weles host. It asks Stado which machine currently
// holds the Apple account, then runs one installed helper there through the registry
// channel; that helper captures the active Apple 2FA notification and relays the six
// digits directly to Skarbiec. No code returns through this process or stdout.

import { spawnSync } from 'node:child_process';
import { assertAppleAuthChallengeOpen, recordAppleAuthChallengeCaptured } from '../../dist/auth/apple-submit-guard.js';
import { appleAccountHolder, stadoBinary } from './apple-account-placement.mjs';

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

// Which host holds the account is asked of Stado, in the one place that asks it:
// `apple-account-placement.mjs`. The resolution used to be copied here, and a copy of
// this particular question is worse than most, because the two callers that ask it --
// the trajectory deciding whether it needs a relay at all, and this program choosing
// where to send one -- have to reach the same host or the capture goes to a machine
// nobody is waiting on.

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
const host = appleAccountHolder(process.env.APPLE_2FA_ACCOUNT_IDENTITY ?? '');

await assertAppleAuthChallengeOpen(guardId, accountId, actionLogId);

const stado = stadoBinary();
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
