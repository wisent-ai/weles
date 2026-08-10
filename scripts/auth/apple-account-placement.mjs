// Where an Apple two-factor prompt is going to appear, and therefore which machine
// has to be standing there to catch it.
//
// Two questions, and Stado answers both: which host holds the account, and which
// host is this one. A deployment that answers them from its own environment answers
// them once, at install time, and then keeps giving that answer after the account
// signs out or the job moves to another worker. That is precisely what
// APPLE_2FA_MAC_HOST did -- it named a Mac somebody had checked once -- and a second
// variable saying "relay is configured here" repeats the mistake one level up: it
// records a conclusion about the fleet in a file on one host. The registry already
// carries the fact both of those were approximating, so ask it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Stado lives under `.stado/bin` on the fleet's Macs and under `.local/bin` on hosts
// that installed it the other way. A single hard-coded default is therefore wrong on
// part of the estate -- the worker that runs these trajectories has no
// `.local/bin/stado` at all -- and the failure it produces reads as "Stado could not
// be asked", which sounds like the registry is down rather than like a path is wrong.
// STADO_BIN still wins, for a host that keeps it somewhere else again.
export function stadoBinary() {
  const configured = process.env.STADO_BIN?.trim();
  if (configured) return configured;
  const home = process.env.HOME ?? homedir();
  for (const candidate of [
    join(home, '.stado', 'bin', 'stado'),
    join(home, '.local', 'bin', 'stado'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('no Stado binary on this host; set STADO_BIN');
}

function ask(argv) {
  const result = spawnSync(stadoBinary(), argv, { encoding: 'utf8' });
  if (result.error || typeof result.stdout !== 'string') {
    throw new Error(`Stado could not be asked: ${argv.join(' ')}`);
  }
  return result;
}

// The registry's name for this machine, which is the only name the rest of the fleet
// knows it by. Comparing hostnames instead would compare two things the registry does
// not promise to keep equal.
export function thisRegistryHost() {
  const result = ask(['registry', 'self', '--name-only']);
  const name = result.stdout.trim();
  if (result.status !== 0 || !name) {
    throw new Error('Stado could not name this host in the registry');
  }
  return name;
}

// The host observed to hold the account, never one that merely claims to.
//
// `identity verify` goes and looks, because these bindings are granted outside the
// fleet and revoked without telling it: an Apple account signs out on a password
// change and nothing anywhere is updated. Accepting a declared-but-unobserved binding
// would send the capture to a machine that will never show a prompt, and the flow
// would die on a timeout rather than on a sentence naming the host to re-enroll.
export function appleAccountHolder(identity) {
  if (!identity) throw new Error('an Apple account identity is required');
  const result = ask(['identity', 'verify', '--kind', 'apple-account', '--identity', identity, '--json']);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error('Stado returned an unreadable identity report');
  }
  if (!report || report.satisfied !== true || !Array.isArray(report.bindings)) {
    throw new Error(`no host holds apple-account ${identity}`);
  }
  const holder = report.bindings.find((row) => row && row.observed === true
    && typeof row.host === 'string' && row.host);
  if (!holder) throw new Error(`no verified host holds apple-account ${identity}`);
  return holder.host;
}

// `null` when the prompt lands on this very machine, so the caller captures it
// directly; otherwise the registry name of the host that has to be asked.
//
// Returning the target rather than a boolean keeps the two ends from drifting: the
// decision and the destination are one answer from one source, so there is no way to
// decide "relay" here and resolve a different holder a moment later.
export function appleChallengeRelayTarget(identity) {
  const holder = appleAccountHolder(identity);
  return holder === thisRegistryHost() ? null : holder;
}
