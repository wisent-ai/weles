// Asking the operator for the one action a run cannot perform itself.
//
// Some flows stop on a person: Google answers a first sign-in from a fresh
// profile with a push to the account owner's phone, and no amount of
// automation taps it. Until now that waiting was invisible — the authenticator
// enrolment printed one line into its own log, waited five minutes and died
// with `google_push_not_approved`, while the operator was never told that
// anything wanted him, which account it was, or how long he had. The agent
// running the flow filled that gap by hand, in chat, which is not a product.
//
// This module is the product: a run opens a request naming what has to be
// done, the request is paged to the operator through Stado's alert channels,
// it lives as a file anyone can read, and it is closed with whether the
// person acted and how long the run waited. `weles operator-requests` shows
// them; the desktop Approvals screen shows the same records.
//
// A request has two facts and no vocabulary: it is open until `closed_at` is
// written, and when it closes, `approved` says whether the person did the
// thing. Everything else — the deadline, the pages, the detail — describes
// those two.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { stadoBinary } from '../_shared/skarbiec-runtime.mjs';

export const OPERATOR_REQUEST_SCHEMA = 'wisent.weles-operator-request.v1';

const DIRECTORY_VARIABLE = 'WELES_OPERATOR_REQUEST_DIR';
const PAGING_VARIABLE = 'WELES_OPERATOR_REQUEST_PAGING';
const PAGING_DISABLED_VALUE = 'off';
/** Stado's pager is a remote call; a run must not hang on it. */
const PAGE_TIMEOUT_MS = 30_000;
/** Enough of a refusal to name it, never enough to carry a channel's payload. */
const MAX_PAGE_DETAIL_CHARS = 400;
const MILLISECONDS_PER_SECOND = 1000;
/** `list` answers the recent past, not the whole history of the host. */
const DEFAULT_LIST_LIMIT = 20;
const PAGE_CHANNEL = 'stado-alerts';
/** The word `stado alerts send` prints for a channel the provider accepted. */
const DELIVERED_WORD = 'delivered';

/** Where the requests live. One directory per host, overridable for tests. */
export function operatorRequestDir() {
  const configured = String(process.env[DIRECTORY_VARIABLE] || '').trim();
  const root = configured.length > 0 ? configured : join(homedir(), '.weles', 'operator-requests');
  if (!isAbsolute(root)) {
    throw new Error(`${DIRECTORY_VARIABLE} must be an absolute path, got ${root}`);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

function requestFile(id) {
  if (!/^[0-9a-f-]{8,64}$/.test(String(id))) throw new Error(`invalid operator request id: ${id}`);
  return join(operatorRequestDir(), `${id}.json`);
}

function required(value, field) {
  const text = String(value ?? '').trim();
  if (text.length === 0) throw new Error(`operator request needs ${field}`);
  return text;
}

function truncate(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_PAGE_DETAIL_CHARS ? `${flat.slice(0, MAX_PAGE_DETAIL_CHARS)}…` : flat;
}

function write(request) {
  writeFileSync(requestFile(request.id), `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

/** Whether this deployment may page. Off is a choice a test or a rerun makes;
 * it is recorded, so a request nobody was told about never looks delivered. */
function pagingEnabled() {
  return String(process.env[PAGING_VARIABLE] || '').trim().toLowerCase() !== PAGING_DISABLED_VALUE;
}

/** What the operator actually reads. Every line answers one question he would
 * otherwise have to ask: what, for which account, where, by when, and how to
 * look at it. */
export function pageBody(request) {
  return [
    'Weles is waiting for one action from you.',
    '',
    `What to do:  ${request.instruction}`,
    `Account:     ${request.account}`,
    `Host:        ${request.host}`,
    `Run:         ${request.run}`,
    `Waiting for: ${request.deadline_seconds}s, until ${request.deadline_at}`,
    `Request:     ${request.id}`,
    '',
    `Watch it:    weles operator-requests show ${request.id}`,
    'If nobody acts before the deadline, the run stops and this request is recorded as unanswered.',
  ].join('\n');
}

export function pageSubject(request) {
  return `Weles waits for you: ${request.kind} (${request.account})`;
}

/** Page every alert channel Stado has, and record what the attempt did.
 * Paging is best effort by construction: a run that cannot reach the pager
 * still waits, because the operator may be looking at the screen — but the
 * record says nobody was told, which is the difference between a silent
 * timeout and a diagnosed one. */
function page(request) {
  const at = new Date().toISOString();
  if (!pagingEnabled()) {
    return { at, ok: false, channel: PAGE_CHANNEL, detail: `paging disabled by ${PAGING_VARIABLE}=${PAGING_DISABLED_VALUE}` };
  }
  let binary;
  try {
    binary = stadoBinary();
  } catch (error) {
    return {
      at, ok: false, channel: PAGE_CHANNEL,
      detail: truncate(`Stado pager unavailable: ${error?.message || error}`),
    };
  }
  const result = spawnSync(binary, ['alerts', 'send', pageBody(request), '--subject', pageSubject(request)], {
    encoding: 'utf8', timeout: PAGE_TIMEOUT_MS, env: { ...process.env, HOME: homedir() },
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
    return { at, ok: false, channel: PAGE_CHANNEL, detail: truncate(`stado alerts send refused: ${detail}`) };
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
      at, ok: false, channel: PAGE_CHANNEL,
      detail: 'stado alerts send exited successfully without naming a channel that took the message',
    };
  }
  return { at, ok: true, channel: PAGE_CHANNEL, detail: truncate(named.join('; ')) };
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
    return listOperatorRequests({ openOnly: true, limit: Number.MAX_SAFE_INTEGER })
        .find((request) => request.kind === wanted && request.account === who);
}

/**
 * Open a request and tell the operator about it.
 *
 * The caller keeps waiting for its own condition; this records the wait and
 * makes it visible. `closeOperatorRequest` is what says how it ended. An
 * identical request already waiting is returned as it stands: the person is
 * asked once, not once per run that needs the same hand.
 */
export function openOperatorRequest(input) {
  const seconds = Number(input.deadlineSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`operator request needs a positive deadlineSeconds, got ${input.deadlineSeconds}`);
  }
  const waiting = openRequestFor(input.kind, input.account);
  if (waiting && !isOverdue(waiting)) return waiting;
  const opened = new Date();
  const request = {
    schema: OPERATOR_REQUEST_SCHEMA,
    id: randomUUID(),
    kind: required(input.kind, 'a kind'),
    account: required(input.account, 'an account'),
    instruction: required(input.instruction, 'an instruction for the operator'),
    run: required(input.run, 'the run that is waiting'),
    host: hostname(),
    opened_at: opened.toISOString(),
    deadline_seconds: Math.round(seconds),
    deadline_at: new Date(opened.getTime() + seconds * MILLISECONDS_PER_SECOND).toISOString(),
    closed_at: null,
    approved: null,
    waited_seconds: null,
    outcome_detail: '',
    pages: [],
  };
  write(request);
  request.pages.push(page(request));
  return write(request);
}

/**
 * Close a request: did the person do it, and what does the run say about it.
 */
export function closeOperatorRequest(id, approved, detail) {
  if (typeof approved !== 'boolean') {
    throw new Error(`operator request closes with approved true or false; got ${approved}`);
  }
  const request = readOperatorRequest(id);
  const closed = new Date();
  request.approved = approved;
  request.closed_at = closed.toISOString();
  request.waited_seconds = Math.max(
    0,
    Math.round((closed.getTime() - new Date(request.opened_at).getTime()) / MILLISECONDS_PER_SECOND),
  );
  request.outcome_detail = truncate(required(detail, 'a sentence saying how the wait ended'));
  return write(request);
}

export function readOperatorRequest(id) {
  const parsed = JSON.parse(readFileSync(requestFile(id), 'utf8'));
  if (parsed?.schema !== OPERATOR_REQUEST_SCHEMA) {
    throw new Error(`${requestFile(id)} is not a ${OPERATOR_REQUEST_SCHEMA} record`);
  }
  return parsed;
}

export function isOpen(request) {
  return !request.closed_at;
}

/** An open request whose deadline has passed: the run that opened it died
 * without saying how it ended. Naming it is the whole point — it reads as
 * unanswered, not as still hoping. */
export function isOverdue(request) {
  return isOpen(request) && Date.now() > new Date(request.deadline_at).getTime();
}

/** The recent requests, newest first. `openOnly` answers the one question an
 * operator asks in a hurry: is anything waiting for me right now. */
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
    .sort((left, right) => String(right.opened_at).localeCompare(String(left.opened_at)));
  return selected.slice(0, Number.isFinite(limit) && limit > 0 ? Math.round(limit) : DEFAULT_LIST_LIMIT);
}
