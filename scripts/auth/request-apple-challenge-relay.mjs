#!/usr/bin/env node

// Runs on the authorized external Weles host, and refuses. It asks Stado which machine
// holds the Apple account, and when that machine is not the one executing, there is no
// longer any channel that can carry the captured digits between the two: it says so,
// naming both hosts and the commit that removed the channel.

import { assertAppleAuthChallengeOpen } from '../../dist/auth/apple-submit-guard.js';
import { appleAccountHolder, thisRegistryHost } from './apple-account-placement.mjs';

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

// Reaching the holder was Stado's job, and the job no longer exists.
//
// This script once opened its own ssh connection, carrying a private key file, a
// private known_hosts, a port and an absolute remote path -- six environment variables
// describing a channel that exists nowhere in the registry. That was the same action
// with the audit trail removed, so it was replaced by `stado host run-helper`, which
// the fleet authenticated, logged and owned. That subcommand was then removed, on
// 2026-08-18, by commit f1e6c081, "Remove the host helper channel".
//
// Every host in the fleet now runs a Stado built after that date, so the relay did not
// degrade: it exited with `unrecognized subcommand 'run-helper'` while reporting a
// helper that had never been asked anything. Neither predecessor is coming back here.
// A hand-rolled ssh path is what the registry exists to prevent, and a retired
// subcommand cannot be called.
//
// What survives is placement. The prompt appears on the machines Apple trusts, and it
// can only be read by a process inside the GUI session those machines are logged into.
// So the capture runs where the account is signed in, or it does not run: this script
// is reached only when the holder is some OTHER host than the one executing, and that
// arrangement has no way to move the six digits between the two.
//
// Refuse with both names, because the pair is the whole diagnosis: an operator who
// knows which host holds the account and which host is running can either sign the
// account into the running host's automated session, or place the trajectory on the
// holder. A generic failure sentence sends them to read this file instead.
const host = appleAccountHolder(process.env.APPLE_2FA_ACCOUNT_IDENTITY ?? '');

await assertAppleAuthChallengeOpen(guardId, accountId, actionLogId);

throw new Error(
  `Apple two-factor capture must run on the host that holds the account. `
  + `${host} holds ${process.env.APPLE_2FA_ACCOUNT_IDENTITY ?? '(no identity given)'} `
  + `and this trajectory is running on ${thisRegistryHost()}. `
  + `Stado's host helper channel, which used to carry the capture between them, was `
  + `removed on 2026-08-18 in commit f1e6c081; nothing replaced it. Either place this `
  + `trajectory on ${host}, or sign the account into the automated GUI session of the `
  + `host that runs it.`,
);
