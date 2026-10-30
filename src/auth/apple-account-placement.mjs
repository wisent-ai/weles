// Apple two-factor placement and transport.
//
// Stado resolves both ends from the live registry: the macOS session that holds
// the account and the worker whose Weles capability broker will redeem the code.
// The preflight opens no prompt; the relay captures only after Apple has asked
// for 2FA and returns a receipt with no digits.

import { spawnSync } from 'node:child_process';
import { stadoBinary } from '../_shared/skarbiec-runtime.mjs';
import { DeclaredError } from '../errors/index.cjs';
import { causes } from '../errors/operations/executor.cjs';
import { causes as signin } from '../errors/operations/sign-in.cjs';

const EXIT_SUCCESS = 0; // https://pubs.opengroup.org/onlinepubs/9799919799/functions/exit.html EXIT_SUCCESS

/**
 * One Stado command's JSON answer; a failure names the command and says what
 * Stado said on stderr. Its stdout is never quoted: an `identity issue`
 * answer carries capabilities, so only its length is named.
 */
function readStadoJson(argv) {
  const command = argv.join(' ');
  let program;
  try {
    program = stadoBinary();
  } catch (error) {
    throw new DeclaredError(
      causes.STADO_UNAVAILABLE,
      { command, answer: error.message },
      { cause: error },
    );
  }
  const result = spawnSync(program, argv, { encoding: 'utf8' });
  if (result.error)
    throw new DeclaredError(
      causes.STADO_UNAVAILABLE,
      { command, answer: `${program}: ${result.error.message}` },
      { cause: result.error },
    );
  if (result.status !== EXIT_SUCCESS) {
    const said = result.stderr.trim();
    throw new DeclaredError(causes.STADO_REFUSED, {
      command,
      status: result.status ?? `on signal ${result.signal}`,
      answer: said === '' ? 'it printed nothing on standard error' : said,
    });
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new DeclaredError(
      causes.STADO_ANSWER,
      {
        command,
        answer: `${result.stdout.length} characters that are not JSON: ${error.message}`,
      },
      { cause: error },
    );
  }
}

function runChallengeCommand(argv, expectedStatus) {
  const report = readStadoJson(argv);
  if (
    !report ||
    report.status !== expectedStatus ||
    typeof report.holder !== 'string' ||
    !report.holder ||
    typeof report.user !== 'string' ||
    !report.user ||
    typeof report.destination !== 'string' ||
    !report.destination
  ) {
    throw new DeclaredError(signin.CHALLENGE_NOT_CONFIRMED, {
      command: argv.join(' '),
      expected: expectedStatus,
      answer: JSON.stringify(report),
    });
  }
  return report;
}

function relayArguments(identity, authorizationId) {
  if (!identity) throw new Error('an Apple account identity is required');
  if (!authorizationId)
    throw new Error('an Apple authorization id is required');
  return [
    'identity',
    'relay',
    '--provider',
    'apple',
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
  return runChallengeCommand(
    relayArguments(identity, authorizationId),
    'stored',
  );
}

export function issueAppleLoginCapabilities({
  executionHost,
  executionAgent,
  authorizationId,
  ttlSeconds,
}) {
  const report = readStadoJson([
    'identity',
    'issue',
    '--provider',
    'apple',
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
  if (
    !report ||
    report.status !== 'issued' ||
    report.target !== executionHost ||
    !report.capabilities ||
    typeof report.capabilities !== 'object'
  ) {
    // The answer carries capabilities, so only what names them is shown.
    throw new DeclaredError(signin.CAPABILITIES_NOT_ISSUED, {
      host: executionHost,
      answer: `status ${JSON.stringify(report?.status)}, target ${JSON.stringify(report?.target)}, capabilities ${report?.capabilities && typeof report.capabilities === 'object' ? 'present' : 'absent'}`,
    });
  }
  return report.capabilities;
}
