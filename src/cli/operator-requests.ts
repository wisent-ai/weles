// `weles operator-requests` — the requests a run made of the person.
//
// A run that needs a human hand opens a request, Stado pages the operator,
// and this is where anyone looks at what was asked, whether the page went
// out, how long the run waited and whether the person did it. `open` and
// `close` are here too, so any product on the host — not only a Weles
// trajectory — can ask through the same record instead of inventing its own
// way of nagging.

import type { ParsedCli } from '../cli.js';
import type { OperatorRequest } from '../operator/request.mjs' with { 'resolution-mode': 'import' };
import type * as OperatorRequestApi from '../operator/request.mjs' with { 'resolution-mode': 'import' };

const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;

/** The store is plain ESM and this CLI compiles to CommonJS, so every verb
 * reaches it through the same dynamic import. */
async function requests(): Promise<typeof OperatorRequestApi> {
  return import('#operator-request');
}

/** One line per request: what it is, who it is for, and where it stands. */
function summarise(request: OperatorRequest, overdue: boolean): string {
  const paged = request.pages.some((attempt) => attempt.ok);
  const left = Math.round((new Date(request.deadline_at).getTime() - Date.now()) / MILLISECONDS_PER_SECOND);
  const standing = request.closed_at
    ? `${request.approved ? 'done by operator' : 'not done'} after ${request.waited_seconds}s`
    : overdue
      ? `waiting, deadline passed ${-left}s ago`
      : `waiting, ${left}s left`;
  return [
    request.id,
    request.kind,
    request.account,
    paged ? 'paged' : 'NOT PAGED',
    standing,
  ].join('  ');
}

function detail(request: OperatorRequest, overdue: boolean): string {
  const lines = [
    `id           ${request.id}`,
    `kind         ${request.kind}`,
    `account      ${request.account}`,
    `run          ${request.run}`,
    `host         ${request.host}`,
    `asks for     ${request.instruction}`,
    `opened       ${request.opened_at}`,
    `deadline     ${request.deadline_at} (${request.deadline_seconds}s)`,
  ];
  for (const attempt of request.pages) {
    lines.push(`page         ${attempt.at} ${attempt.channel} ${attempt.ok ? 'sent' : 'failed'}: ${attempt.detail}`);
  }
  if (request.pages.length === 0) lines.push('page         nobody was told');
  if (request.closed_at) {
    lines.push(`closed       ${request.closed_at} after ${request.waited_seconds}s`);
    lines.push(`operator     ${request.approved ? 'did it' : 'did not do it'}`);
    lines.push(`outcome      ${request.outcome_detail}`);
  } else {
    lines.push(`open         ${overdue ? 'yes, past its deadline and nobody closed it' : 'yes'}`);
  }
  return lines.join('\n');
}

function numberOption(parsed: ParsedCli, key: string): number | undefined {
  const raw = parsed.options[key];
  if (typeof raw !== 'string') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number, got ${raw}`);
  return value;
}

function textOption(parsed: ParsedCli, key: string): string {
  const raw = parsed.options[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`operator-requests open requires --${key} <text>`);
  }
  return raw.trim();
}

async function listRequests(parsed: ParsedCli): Promise<void> {
  const api = await requests();
  const found = api.listOperatorRequests({ limit: numberOption(parsed, 'limit'), openOnly: parsed.options.open === true });
  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
    return;
  }
  if (found.length === 0) {
    process.stdout.write(`no operator requests in ${api.operatorRequestDir()}\n`);
    return;
  }
  for (const request of found) process.stdout.write(`${summarise(request, api.isOverdue(request))}\n`);
}

async function showRequest(parsed: ParsedCli): Promise<void> {
  const api = await requests();
  const id = parsed.positional[1];
  if (!id) throw new Error('operator-requests show requires <id>');
  const request = api.readOperatorRequest(id);
  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(request, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${detail(request, api.isOverdue(request))}\n`);
}

async function openRequest(parsed: ParsedCli): Promise<void> {
  const api = await requests();
  const minutes = numberOption(parsed, 'minutes');
  if (minutes === undefined) throw new Error('operator-requests open requires --minutes <number>');
  const request = api.openOperatorRequest({
    kind: textOption(parsed, 'kind'),
    account: textOption(parsed, 'account'),
    instruction: textOption(parsed, 'instruction'),
    run: textOption(parsed, 'run'),
    deadlineSeconds: minutes * SECONDS_PER_MINUTE,
  });
  const paged = request.pages.some((attempt) => attempt.ok);
  if (!paged) process.exitCode = 2;
  process.stdout.write(`${detail(request, false)}\n`);
}

async function closeRequest(parsed: ParsedCli): Promise<void> {
  const api = await requests();
  const id = parsed.positional[1];
  if (!id) throw new Error('operator-requests close requires <id>');
  const approved = parsed.options.approved === true;
  const unapproved = parsed.options.unapproved === true;
  if (approved === unapproved) {
    throw new Error('operator-requests close requires exactly one of --approved or --unapproved');
  }
  const request = api.closeOperatorRequest(id, approved, textOption(parsed, 'detail'));
  process.stdout.write(`${detail(request, false)}\n`);
}

export async function runOperatorRequests(parsed: ParsedCli): Promise<void> {
  const action = parsed.positional[0] ?? 'list';
  if (action === 'list') return listRequests(parsed);
  if (action === 'show') return showRequest(parsed);
  if (action === 'open') return openRequest(parsed);
  if (action === 'close') return closeRequest(parsed);
  throw new Error(
    `unknown operator-requests action: ${action}; weles operator-requests takes list, show, open or close`,
  );
}
