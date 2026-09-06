// Apple two-factor placement and transport.
//
// Stado resolves both ends from the live registry: the macOS session that holds
// the account and the worker whose Weles capability broker will redeem the code.
// The preflight opens no prompt; the relay captures only after Apple has asked
// for 2FA and returns a receipt with no digits.

import { spawnSync } from 'node:child_process';
import { stadoBinary } from '../_shared/skarbiec-runtime.mjs';

function readStadoJson(argv) {
  const result = spawnSync(stadoBinary(), argv, { encoding: 'utf8' });
  if (result.error || typeof result.stdout !== 'string') {
    throw new Error(`Stado could not be asked: ${argv.join(' ')}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`)
      .trim()
      .split(/\r?\n/)
      .at(-1);
    throw new Error(detail || `Stado refused: ${argv.join(' ')}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('Stado returned unreadable JSON');
  }
}

function runChallengeCommand(argv, expectedStatus) {
  const report = readStadoJson(argv);
  if (!report || report.status !== expectedStatus
      || typeof report.holder !== 'string' || !report.holder
      || typeof report.user !== 'string' || !report.user
      || typeof report.destination !== 'string' || !report.destination) {
    throw new Error(`Stado did not confirm Apple challenge ${expectedStatus}`);
  }
  return report;
}

function relayArguments(identity, authorizationId) {
  if (!identity) throw new Error('an Apple account identity is required');
  if (!authorizationId) throw new Error('an Apple authorization id is required');
  return [
    'identity',
    'relay-apple-challenge',
    '--identity',
    identity,
    '--authorization-id',
    authorizationId,
    '--json',
  ];
}

export function preflightAppleChallengeRelay(identity, authorizationId) {
  return runChallengeCommand(
    [...relayArguments(identity, authorizationId), '--preflight'],
    'ready',
  );
}

export function relayAppleChallenge(identity, authorizationId) {
  return runChallengeCommand(relayArguments(identity, authorizationId), 'stored');
}

export function issueAppleLoginCapabilities({
  executionHost,
  executionAgent,
  authorizationId,
  ttlSeconds,
}) {
  const report = readStadoJson([
    'identity',
    'issue-apple-capabilities',
    '--target',
    executionHost,
    '--agent',
    executionAgent,
    '--authorization-id',
    authorizationId,
    '--ttl-seconds',
    String(ttlSeconds),
    '--json',
  ]);
  if (!report || report.status !== 'issued' || report.target !== executionHost
      || !report.capabilities || typeof report.capabilities !== 'object') {
    throw new Error('Stado did not issue Apple capabilities on the execution host');
  }
  return report.capabilities;
}
