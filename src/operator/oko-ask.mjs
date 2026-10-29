// Putting an operator request to the operator as one Oko ask on the channels
// he chose (`oko contact`), carrying his answer back onto the request, and
// withdrawing the ask when the request closes.

import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  PAGING_DISABLED_VALUE,
  PAGING_VARIABLE,
  pageSubject,
  pagingEnabled,
} from './page.mjs';
import {
  answerOperatorRequest,
  flatten,
  isOpen,
  noteOperatorRequest,
  OPERATOR_ANSWERS,
  readOperatorRequest,
} from './record.mjs';

const OKO_CHANNEL = 'oko-asks';
/** The program that records an ask in the shared Oko database; a deployment
 * whose `oko` is not on PATH names it here. */
const OKO_BINARY_VARIABLE = 'WELES_OKO_BIN';

/** The `oko` program: the one `WELES_OKO_BIN` names, or, when it is unset or
 * empty, the `oko` on PATH. */
export function okoBinary() {
  const named = process.env[OKO_BINARY_VARIABLE];
  if (typeof named === 'string' && named.trim()) return named.trim();
  return 'oko';
}

/** Everything a failed `oko` call left to say why: its exit status, the
 * spawn error, and what it wrote on stderr and stdout. */
function refusalDetail(result) {
  const parts = [`exit ${result.status}`];
  if (result.error) parts.push(result.error.message);
  if (typeof result.stderr === 'string' && result.stderr.trim()) {
    parts.push(`stderr: ${result.stderr.trim()}`);
  }
  if (typeof result.stdout === 'string' && result.stdout.trim()) {
    parts.push(`stdout: ${result.stdout.trim()}`);
  }
  return parts.join('; ');
}

/** The page attempt recorded when the question did not reach Oko, with why. */
function notAsked(at, detail) {
  return { at, ok: false, channel: OKO_CHANNEL, detail: flatten(detail) };
}

/** The Weles run waiting on a request, when a worker started it; `null` when
 * none did. */
function firstRun(request) {
  if (!Array.isArray(request.run_ids)) return null;
  const [first] = request.run_ids;
  return first === undefined ? null : first;
}

/**
 * Put the question on the channels the operator chose in Oko (`oko contact`):
 * one ask in the shared Oko database, delivered and tracked there, shown in
 * Oko Desktop and Oko iOS. Oko pages the channels Stado reaches itself, so a
 * host with Oko asks once. Weles runs without Oko too: a host with no `oko`
 * is recorded as a channel not tried, with that reason, and the request is
 * paged through Stado's alert channels instead. Oko's own refusal (no channel
 * chosen, nobody signed in) is recorded verbatim.
 */
export function askThroughOko(request) {
  const at = new Date().toISOString();
  if (!pagingEnabled()) {
    return {
      at,
      ok: false,
      channel: OKO_CHANNEL,
      detail: `asking disabled by ${PAGING_VARIABLE}=${PAGING_DISABLED_VALUE}`,
    };
  }
  const binary = okoBinary();
  const run = firstRun(request);
  const answer = run
    ? `Answer it here with one of the choices, which the run receives at once, or with: weles runs answer ${run} --ready | --approved | --not-received`
    : `No Weles worker started this run (process ${request.run_pid} on ${request.host}); it ends when the page it waits on changes.`;
  // The answers a waiting run acts on are offered as the ask's choices, so
  // Oko Desktop and Oko iOS show them as buttons and refuse anything else.
  const result = spawnSync(
    binary,
    [
      'asks',
      'ask',
      '--from',
      'weles',
      '--subject',
      run ? `run-${run}` : `request-${request.id}`,
      '--question',
      `${request.instruction} (${request.account})`,
      '--detail',
      `${pageSubject(request)} on ${request.host}. ${answer}`,
      ...OPERATOR_ANSWERS.flatMap((choice) => ['--choice', choice]),
    ],
    { encoding: 'utf8', env: { ...process.env, HOME: homedir() } },
  );
  if (result.error?.code === 'ENOENT') {
    return {
      at,
      ok: false,
      channel: OKO_CHANNEL,
      oko_missing: true,
      detail: `${binary} is not installed on this host (set ${OKO_BINARY_VARIABLE} to its path), so the question was not put on the operator's Oko channels`,
    };
  }
  if (result.error || result.status) {
    return notAsked(at, `oko asks ask refused: ${refusalDetail(result)}`);
  }
  let asked;
  try {
    asked = JSON.parse(result.stdout);
  } catch (error) {
    return notAsked(
      at,
      `oko asks ask answered unreadable JSON: ${error.message}`,
    );
  }
  const askId = asked.ask?.id;
  if (!askId) {
    return notAsked(
      at,
      `oko asks ask answered without an ask id, so the ask cannot be followed or withdrawn: ${result.stdout}`,
    );
  }
  if (!Array.isArray(asked.deliveries)) {
    return {
      at,
      ok: true,
      channel: OKO_CHANNEL,
      ask_id: askId,
      detail: flatten(
        `ask ${askId} recorded in Oko, whose answer listed no deliveries; they are recorded as they happen: oko asks show ${askId}`,
      ),
    };
  }
  const delivered = asked.deliveries.filter(
    (attempt) => attempt.outcome === 'delivered',
  );
  return {
    at,
    ok: true,
    channel: OKO_CHANNEL,
    ask_id: askId,
    detail: flatten(
      `ask ${askId} recorded in Oko; ${
        delivered.length
          ? delivered
              .map((attempt) => `${attempt.channel}: ${attempt.detail}`)
              .join('; ')
          : `its deliveries are recorded as they happen: oko asks show ${askId}`
      }`,
    ),
  };
}

/** Withdraw the Oko ask of a request that closed, so Oko does not keep
 * asking for something the run no longer waits on. The outcome is kept as a
 * note on the request. */
export function withdrawOkoAsk(request) {
  // A request that was never paged holds no Oko ask to withdraw.
  if (!Array.isArray(request.pages)) return;
  const asked = request.pages.find(
    (attempt) => attempt.channel === OKO_CHANNEL && attempt.ask_id,
  );
  if (!asked) return;
  const result = spawnSync(okoBinary(), ['asks', 'withdraw', asked.ask_id], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homedir() },
  });
  const note =
    result.error || result.status
      ? flatten(
          `Oko ask ${asked.ask_id} not withdrawn: ${refusalDetail(result)}`,
        )
      : `Oko ask ${asked.ask_id} withdrawn`;
  request.notes = [
    ...(Array.isArray(request.notes) ? request.notes : []),
    { at: new Date().toISOString(), note },
  ];
}

/**
 * Carry the answer the operator gives in Oko Desktop or Oko iOS onto the
 * request, where the waiting run watches for it (`nextOperatorAnswer`).
 * `oko asks wait` returns when the ask stops waiting: answered with one of
 * the choices the request offered, it becomes the request's answer from Oko;
 * withdrawn (the request closed first) or expired, nothing is answered. A
 * wait that fails is kept as a note naming Oko's words, and `weles runs
 * answer` still answers the run.
 */
export function relayOkoAnswer(requestId, askId) {
  const child = spawn(okoBinary(), ['asks', 'wait', askId], {
    env: { ...process.env, HOME: homedir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  // The wait lasts as long as the ask does, but never holds the run's process
  // open: its pipes and the child are unreferenced, and a run that ends first
  // ends the wait with it.
  child.stdout.unref();
  child.stderr.unref();
  child.unref();
  process.once('exit', () => child.kill());
  const note = (text) => {
    try {
      if (isOpen(readOperatorRequest(requestId)))
        noteOperatorRequest(requestId, text);
    } catch (error) {
      console.error(
        `[operator-request] ${requestId}: ${text}; the note could not be written: ${error.message}`,
      );
    }
  };
  child.on('error', (error) =>
    note(`Oko ask ${askId} cannot be waited on: ${error.message}`),
  );
  child.on('close', (code) => {
    if (code) {
      note(
        `oko asks wait ${askId} exited ${code}: ${flatten(stderr || stdout)}`,
      );
      return;
    }
    let waited;
    try {
      waited = JSON.parse(stdout);
    } catch (error) {
      note(`oko asks wait ${askId} answered unreadable JSON: ${error.message}`);
      return;
    }
    if (waited.standing !== 'answered') return;
    const answer = String(waited.ask?.answer);
    try {
      if (!isOpen(readOperatorRequest(requestId))) return;
      if (!OPERATOR_ANSWERS.includes(answer)) {
        note(
          `Oko ask ${askId} was answered with ${answer}, which is none of ${OPERATOR_ANSWERS.join(', ')}`,
        );
        return;
      }
      answerOperatorRequest(
        requestId,
        answer,
        `answered in Oko on ${waited.ask?.answered_on}`,
      );
    } catch (error) {
      note(
        `the answer ${answer} given in Oko could not be put on the request: ${error.message}`,
      );
    }
  });
}
