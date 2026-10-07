// Asking the operator for the one action a run cannot perform itself.
//
// Some flows stop on a person: Google answers a first sign-in from a fresh
// profile with a push to the account owner's phone, and no amount of
// automation taps it. Until now that waiting was invisible — the operator was
// never told that anything wanted him or which account it was. The agent
// running the flow filled that gap by hand, in chat, which is not a product.
//
// This module is the product: a run opens a request naming what has to be
// done, the request is put to the operator as one Oko ask on the channels he
// chose (`oko contact`), or paged through Stado's alert channels on a host
// without Oko; it lives as a file the worker reads, and it is closed with
// whether the
// person acted and how long the run waited. A request belongs to the runs
// that wait on it: `weles runs list|show` show what a run waits for, and
// `weles runs answer` is how the operator answers it.
//
// A request has two facts and no vocabulary: it is open until `closed_at` is
// written, and when it closes, `approved` says whether the person did the
// thing. A request carries the process id of the run that waits on it: the
// request stays open as long as that run is alive, and an open request whose
// run has exited without closing it reads as abandoned. No clock decides
// either.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { stadoBinary } from '../_shared/skarbiec-runtime.mjs';

export const OPERATOR_REQUEST_SCHEMA = 'wisent.weles-operator-request.v1';

const DIRECTORY_VARIABLE = 'WELES_OPERATOR_REQUEST_DIR';
const PAGING_VARIABLE = 'WELES_OPERATOR_REQUEST_PAGING';
const PAGING_DISABLED_VALUE = 'off';
const MILLISECONDS_PER_SECOND = 1000;
const PAGE_CHANNEL = 'stado-alerts';
/** The word `stado alerts send` prints for a channel the provider accepted. */
const DELIVERED_WORD = 'delivered';
/**
 * Set by the API server on every run it spawns; the run's stderr is the
 * progress channel its caller reads (`STEP`, `AUTH_FAILURE`, and this).
 */
const RUN_ID_VARIABLE = 'ACTION_LOG_ID';
const PROGRESS_WORD = 'OPERATOR_REQUEST';

/**
 * Tell whoever ordered this run that it now waits for a person. Nothing on the
 * page changes until the person acts, so without this line the caller waits in
 * silence and cannot say what it waits for. Only a run the API server spawned
 * has a caller reading its stderr.
 */
function announce(request) {
  if (!currentRunId()) return;
  process.stderr.write(
    `${PROGRESS_WORD} ${JSON.stringify({
      id: request.id,
      kind: request.kind,
      account: request.account,
      instruction: request.instruction,
      host: request.host,
      opened_at: request.opened_at,
      paged: request.pages.some((attempt) => attempt.ok),
    })}\n`,
  );
}

/** Where the requests live. One directory per host, overridable for tests. */
export function operatorRequestDir() {
  const configured = String(process.env[DIRECTORY_VARIABLE] || '').trim();
  const root =
    configured.length > 0
      ? configured
      : join(homedir(), '.weles', 'operator-requests');
  if (!isAbsolute(root)) {
    throw new Error(
      `${DIRECTORY_VARIABLE} must be an absolute path, got ${root}`,
    );
  }
  mkdirSync(root, { recursive: true });
  return root;
}

function requestFile(id) {
  if (!/^[0-9a-f-]{8,64}$/.test(String(id)))
    throw new Error(`invalid operator request id: ${id}`);
  return join(operatorRequestDir(), `${id}.json`);
}

function required(value, field) {
  const text = String(value ?? '').trim();
  if (text.length === 0) throw new Error(`operator request needs ${field}`);
  return text;
}

/** One line, whole: a refusal is quoted as the channel said it. */
function flatten(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function write(request) {
  writeFileSync(
    requestFile(request.id),
    `${JSON.stringify(request, null, 2)}\n`,
  );
  return request;
}

/** Whether this deployment may page. Off is a choice a test or a rerun makes;
 * it is recorded, so a request nobody was told about never looks delivered. */
function pagingEnabled() {
  return (
    String(process.env[PAGING_VARIABLE] || '')
      .trim()
      .toLowerCase() !== PAGING_DISABLED_VALUE
  );
}

/** What the operator actually reads. Every line answers one question he would
 * otherwise have to ask: what, for which account, where, who is waiting, and
 * how to answer. A run the worker did not start has no run id, so nothing can
 * answer it but the page it waits on. */
export function pageBody(request) {
  const runIds = Array.isArray(request.run_ids) ? request.run_ids : [];
  return [
    'Weles is waiting for one action from you.',
    '',
    `What to do:  ${request.instruction}`,
    `Account:     ${request.account}`,
    `Host:        ${request.host}`,
    `Run:         ${request.run} (${runIds.length ? `Weles run ${runIds.join(', ')}` : `process ${request.run_pid}; not started by a Weles worker`})`,
    '',
    ...(runIds.length
      ? [
          `Watch it:    weles runs show ${runIds[0]}`,
          `Answer it:   weles runs answer ${runIds[0]} --ready | --approved | --not-received`,
        ]
      : []),
    'The run waits until you act or it is cancelled; if it ends first, this request is recorded as abandoned.',
  ].join('\n');
}

export function pageSubject(request) {
  return `Weles waits for you: ${request.kind} (${request.account})`;
}

/** Page every alert channel Stado has, and record what the attempt did.
 * Paging is best effort by construction: a run that cannot reach the pager
 * still waits, because the operator may be looking at the screen — but the
 * record says nobody was told, which is the difference between a silent
 * wait and a diagnosed one. */
function page(request) {
  const at = new Date().toISOString();
  if (!pagingEnabled()) {
    return {
      at,
      ok: false,
      channel: PAGE_CHANNEL,
      detail: `paging disabled by ${PAGING_VARIABLE}=${PAGING_DISABLED_VALUE}`,
    };
  }
  let binary;
  try {
    binary = stadoBinary();
  } catch (error) {
    return {
      at,
      ok: false,
      channel: PAGE_CHANNEL,
      detail: flatten(`Stado pager unavailable: ${error?.message || error}`),
    };
  }
  const result = spawnSync(
    binary,
    ['alerts', 'send', pageBody(request), '--subject', pageSubject(request)],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: homedir() },
    },
  );
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ||
      result.stderr ||
      result.stdout ||
      `exit ${result.status}`;
    return {
      at,
      ok: false,
      channel: PAGE_CHANNEL,
      detail: flatten(`stado alerts send refused: ${detail}`),
    };
  }
  // Stado names each channel and what it did: `resend\tdelivered\t<address>`.
  // A pager that exits zero saying nothing is not evidence that anyone was
  // reached — older Stado releases exited zero even when every provider
  // refused — so the record says exactly that instead of claiming delivery.
  const named = String(result.stdout || '')
    .split('\n')
    .filter((line) => line.includes(`\t${DELIVERED_WORD}\t`));
  if (named.length === 0) {
    return {
      at,
      ok: false,
      channel: PAGE_CHANNEL,
      detail:
        'stado alerts send exited successfully without naming a channel that took the message',
    };
  }
  return {
    at,
    ok: true,
    channel: PAGE_CHANNEL,
    detail: flatten(named.join('; ')),
  };
}

const OKO_CHANNEL = 'oko-asks';
/** The program that records an ask in the shared Oko database; a deployment
 * whose `oko` is not on PATH names it here. */
const OKO_BINARY_VARIABLE = 'WELES_OKO_BIN';

function okoBinary() {
  return String(process.env[OKO_BINARY_VARIABLE] || '').trim() || 'oko';
}

/** The Weles run waiting on a request, when a worker started it. */
function firstRun(request) {
  const [first] = Array.isArray(request.run_ids) ? request.run_ids : [];
  return first || null;
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
function askThroughOko(request) {
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
    const detail =
      result.error?.message ||
      result.stderr ||
      result.stdout ||
      `exit ${result.status}`;
    return {
      at,
      ok: false,
      channel: OKO_CHANNEL,
      detail: flatten(`oko asks ask refused: ${detail}`),
    };
  }
  let asked;
  try {
    asked = JSON.parse(result.stdout);
  } catch (error) {
    return {
      at,
      ok: false,
      channel: OKO_CHANNEL,
      detail: flatten(
        `oko asks ask answered unreadable JSON: ${error.message}`,
      ),
    };
  }
  const delivered = (asked.deliveries || []).filter(
    (attempt) => attempt.outcome === 'delivered',
  );
  return {
    at,
    ok: true,
    channel: OKO_CHANNEL,
    ask_id: asked.ask?.id,
    detail: flatten(
      `ask ${asked.ask?.id} recorded in Oko; ${
        delivered.length
          ? delivered
              .map((attempt) => `${attempt.channel}: ${attempt.detail}`)
              .join('; ')
          : `its deliveries are recorded as they happen: oko asks show ${asked.ask?.id}`
      }`,
    ),
  };
}

/** Withdraw the Oko ask of a request that closed, so Oko does not keep
 * asking for something the run no longer waits on. The outcome is kept as a
 * note on the request. */
function withdrawOkoAsk(request) {
  const asked = (request.pages || []).find(
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
          `Oko ask ${asked.ask_id} not withdrawn: ${result.error?.message || result.stderr || `exit ${result.status}`}`,
        )
      : `Oko ask ${asked.ask_id} withdrawn`;
  request.notes = [
    ...(Array.isArray(request.notes) ? request.notes : []),
    { at: new Date().toISOString(), note },
  ];
}

/**
 * The request already waiting on this person for the same thing, if any.
 *
 * Two runs that hit the same wall — every account in a pool failing the same
 * sign-in, say — would otherwise page the operator once each for one action.
 * A request is the same when it asks the same kind of thing about the same
 * account and nobody has closed it.
 */
export function openRequestFor(kind, account) {
  const wanted = String(kind).trim();
  const who = String(account).trim();
  return listOperatorRequests({ openOnly: true }).find(
    (request) => request.kind === wanted && request.account === who,
  );
}

/** The Weles run this process is, when a worker started it. */
function currentRunId() {
  const runId = String(process.env[RUN_ID_VARIABLE] || '').trim();
  return runId.length > 0 ? runId : null;
}

/**
 * Open a request and tell the operator about it.
 *
 * The caller keeps waiting for its own condition; this records the wait and
 * makes it visible. `closeOperatorRequest` is what says how it ended. An
 * identical request already waiting is returned with this run added to the
 * runs waiting on it: the person is asked once, not once per run that needs
 * the same hand, and every one of those runs can be answered. The waiting
 * process is the caller's own.
 */
export function openOperatorRequest(input) {
  const runId = currentRunId();
  const waiting = openRequestFor(input.kind, input.account);
  if (waiting && isAbandoned(waiting) === false) {
    const runIds = Array.isArray(waiting.run_ids) ? waiting.run_ids : [];
    const joined =
      runId && !runIds.includes(runId)
        ? write({ ...waiting, run_ids: [...runIds, runId] })
        : waiting;
    announce(joined);
    return joined;
  }
  const opened = new Date();
  const request = {
    schema: OPERATOR_REQUEST_SCHEMA,
    id: randomUUID(),
    kind: required(input.kind, 'a kind'),
    account: required(input.account, 'an account'),
    instruction: required(input.instruction, 'an instruction for the operator'),
    run: required(input.run, 'the run that is waiting'),
    run_ids: runId ? [runId] : [],
    run_pid: process.pid,
    host: hostname(),
    opened_at: opened.toISOString(),
    closed_at: null,
    approved: null,
    waited_seconds: null,
    outcome_detail: '',
    pages: [],
  };
  write(request);
  const asked = askThroughOko(request);
  request.pages.push(asked);
  if (asked.oko_missing) request.pages.push(page(request));
  const written = write(request);
  if (asked.ok && asked.ask_id) relayOkoAnswer(written.id, asked.ask_id);
  announce(written);
  return written;
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
function relayOkoAnswer(requestId, askId) {
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

/** The open request a Weles run waits on, or null when it waits on nobody. */
export function openRequestOfRun(runId) {
  return (
    listOperatorRequests({ openOnly: true }).find(
      (request) =>
        Array.isArray(request.run_ids) && request.run_ids.includes(runId),
    ) ?? null
  );
}

/**
 * Close a request: did the person do it, and what does the run say about it.
 */
export function closeOperatorRequest(id, approved, detail) {
  if (typeof approved !== 'boolean') {
    throw new Error(
      `operator request closes with approved true or false; got ${approved}`,
    );
  }
  const request = readOperatorRequest(id);
  const closed = new Date();
  request.approved = approved;
  request.closed_at = closed.toISOString();
  request.waited_seconds = Math.max(
    0,
    Math.round(
      (closed.getTime() - new Date(request.opened_at).getTime()) /
        MILLISECONDS_PER_SECOND,
    ),
  );
  request.outcome_detail = flatten(
    required(detail, 'a sentence saying how the wait ended'),
  );
  withdrawOkoAsk(request);
  return write(request);
}

/**
 * What the operator can tell the run that waits on a request:
 * - `ready`: he has his phone in hand, so the run asks the provider to send
 *   its prompt now; a run sends none before, so no prompt expires unseen;
 * - `approved`: he approved it, so the run reads the page and records what
 *   the provider actually shows, instead of nobody learning the two disagree;
 * - `not_received`: no prompt reached him, or it expired, so the run asks the
 *   provider to send it again, or ends saying the provider offers no second send.
 * Ending the wait is ending the run: `weles runs cancel`.
 */
export const OPERATOR_ANSWERS = Object.freeze([
  'ready',
  'approved',
  'not_received',
]);

/**
 * Record the operator's answer on an open request. The run that waits on it
 * is watching the record (`nextOperatorAnswer`) and acts on it at once. A
 * closed request has no run waiting, so an answer to it is refused with how
 * it ended.
 */
export function answerOperatorRequest(id, answer, detail) {
  if (!OPERATOR_ANSWERS.includes(answer)) {
    throw new Error(
      `operator request answer must be one of ${OPERATOR_ANSWERS.join(', ')}; got ${answer}`,
    );
  }
  const request = readOperatorRequest(id);
  if (!isOpen(request)) {
    throw new Error(
      `operator request ${id} closed at ${request.closed_at} (${request.outcome_detail}); no run waits for an answer`,
    );
  }
  request.answers = [
    ...(Array.isArray(request.answers) ? request.answers : []),
    { at: new Date().toISOString(), answer, detail: flatten(detail) },
  ];
  return write(request);
}

/**
 * Record what the waiting run did about an answer, or saw on the page, so
 * the record says it and not only the run's log.
 */
export function noteOperatorRequest(id, note) {
  const request = readOperatorRequest(id);
  request.notes = [
    ...(Array.isArray(request.notes) ? request.notes : []),
    { at: new Date().toISOString(), note: flatten(required(note, 'a note')) },
  ];
  return write(request);
}

/**
 * Ask the operator again on an open request, through the channels he chose,
 * because what he was asked for changed: `why` says what changed (Google's
 * prompt expired, say) and is kept as a note beside the new page attempt, so
 * the record shows each time he was asked and why.
 */
export function repageOperatorRequest(id, why) {
  const request = readOperatorRequest(id);
  if (!isOpen(request)) {
    throw new Error(
      `operator request ${id} closed at ${request.closed_at}; it cannot be asked again`,
    );
  }
  const reason = flatten(required(why, 'why the operator is asked again'));
  const asked = { ...request, instruction: `${request.instruction} ${reason}` };
  request.notes = [
    ...(Array.isArray(request.notes) ? request.notes : []),
    { at: new Date().toISOString(), note: reason },
  ];
  request.pages = [...request.pages, page(asked)];
  return write(request);
}

/**
 * The first answer recorded after the `seen` answers the caller has already
 * acted on. It watches the request's own file, so the wait ends when the
 * answer is written, not on a clock; `signal` stops watching.
 */
export function nextOperatorAnswer(id, seen, signal) {
  const file = requestFile(id);
  return new Promise((resolve, reject) => {
    let watcher = null;
    const finish = (settle, value) => {
      watcher?.close();
      signal?.removeEventListener('abort', aborted);
      settle(value);
    };
    const aborted = () => finish(resolve, null);
    const look = () => {
      let request;
      try {
        request = readOperatorRequest(id);
      } catch (error) {
        // A record being rewritten reads short for an instant; the write
        // that follows fires the watcher again.
        if (error instanceof SyntaxError) return;
        finish(reject, error);
        return;
      }
      const answers = Array.isArray(request.answers) ? request.answers : [];
      if (answers.length > seen) finish(resolve, answers[seen]);
    };
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    signal?.addEventListener('abort', aborted, { once: true });
    watcher = watch(file, look);
    look();
  });
}

export function readOperatorRequest(id) {
  const parsed = JSON.parse(readFileSync(requestFile(id), 'utf8'));
  if (parsed?.schema !== OPERATOR_REQUEST_SCHEMA) {
    throw new Error(
      `${requestFile(id)} is not a ${OPERATOR_REQUEST_SCHEMA} record`,
    );
  }
  return parsed;
}

export function isOpen(request) {
  return !request.closed_at;
}

/** Only the owning host can observe the waiting process. Missing process
 * identity or an unexpected OS error is unknown, not proof it exited. */
export function isAbandoned(request) {
  if (!isOpen(request)) return false;
  if (
    request.host !== hostname() ||
    !Number.isSafeInteger(request.run_pid) ||
    request.run_pid <= 0
  )
    return null;
  try {
    process.kill(request.run_pid, 0);
    return false;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    if (error?.code === 'EPERM') return false;
    return null;
  }
}

/** The requests, newest first: every one, or the newest `limit` when the
 * caller names a count. `openOnly` answers the one question an operator asks
 * in a hurry: is anything waiting for me right now. */
export function listOperatorRequests(options) {
  const limit = Number(options?.limit);
  const openOnly = options?.openOnly === true;
  const dir = operatorRequestDir();
  const requests = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      requests.push(JSON.parse(readFileSync(join(dir, entry), 'utf8')));
    } catch {
      // A half-written record is not a reason to hide the rest.
    }
  }
  const selected = requests
    .filter((request) => request?.schema === OPERATOR_REQUEST_SCHEMA)
    .filter((request) => (openOnly ? isOpen(request) : true))
    .sort((left, right) =>
      String(right.opened_at).localeCompare(String(left.opened_at)),
    );
  return Number.isFinite(limit) && limit > 0
    ? selected.slice(0, Math.round(limit))
    : selected;
}
