// `weles operator-requests` — the requests a run made of the person.
//
// A run that needs a human hand opens a request, Stado pages the operator,
// and this is where anyone looks at what was asked, whether the page went
// out, how long the run waited and whether the person did it. `open` and
// `close` are here too, so any product on the host — not only a Weles
// trajectory — can ask through the same record instead of inventing its own
// way of nagging.

import type { ParsedCli } from '../cli.js';
import { UsageError } from './usage.js';
import type { OperatorRequest } from '../operator/request.mjs' with { 'resolution-mode': 'import' };
import type * as OperatorRequestApi from '../operator/request.mjs' with { 'resolution-mode': 'import' };
import { readOperatorRequests } from '../runtime/api/approvals/client.js';

/** The store is plain ESM and this CLI compiles to CommonJS, so every verb
 * reaches it through the same dynamic import. */
async function requests(): Promise<typeof OperatorRequestApi> {
  return import('#operator-request');
}

/** One line per request: what it is, who it is for, and where it stands. */
function summarise(request: OperatorRequest, abandoned: boolean | null): string {
  const paged = request.pages.some((attempt) => attempt.ok);
  const standing = request.closed_at
    ? `${request.approved ? 'done by operator' : 'not done'} after ${request.waited_seconds}s`
    : abandoned === null
      ? 'waiting process unreported; its state is unknown'
      : abandoned
        ? `abandoned: run process ${request.run_pid} ended without closing it`
        : `waiting on run process ${request.run_pid}`;
  return [
    request.id,
    request.kind,
    request.account,
    paged ? 'paged' : 'NOT PAGED',
    standing,
  ].join('  ');
}

function detail(request: OperatorRequest, abandoned: boolean | null): string {
  const lines = [
    `id           ${request.id}`,
    `kind         ${request.kind}`,
    `account      ${request.account}`,
    `run          ${request.run} (process ${request.run_pid ?? 'unreported'})`,
    `host         ${request.host}`,
    `asks for     ${request.instruction}`,
    `opened       ${request.opened_at}`,
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
    lines.push(`open         ${abandoned === null ? 'process state unknown' : abandoned ? `abandoned: run process ${request.run_pid} ended and nobody closed it` : 'yes, the run is waiting'}`);
  }
  return lines.join('\n');
}

function numberOption(parsed: ParsedCli, key: string): number | undefined {
  const raw = parsed.options[key];
  if (typeof raw !== 'string') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new UsageError(`--${key} must be a positive integer, got ${raw}`);
  return value;
}

function textOption(parsed: ParsedCli, key: string): string {
  const raw = parsed.options[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new UsageError(`operator-requests open requires --${key} <text>`);
  }
  return raw.trim();
}

async function listRequests(parsed: ParsedCli): Promise<void> {
  const api = await requests();
  const options = { limit: numberOption(parsed, 'limit'), openOnly: parsed.options.open === true };
  const local = parsed.options.local === true;
  const found = local
    ? api.listOperatorRequests(options).map((request) => ({ ...request, abandoned: api.isAbandoned(request) }))
    : await readOperatorRequests(options);
  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
    return;
  }
  if (found.length === 0) {
    process.stdout.write(`no operator requests ${local ? `in ${api.operatorRequestDir()}` : 'on the selected Weles worker'}\n`);
    return;
  }
  for (const request of found) process.stdout.write(`${summarise(request, request.abandoned)}\n`);
}

async function showRequest(parsed: ParsedCli): Promise<void> {
  const api = await requests();
  const id = parsed.positional[1];
  if (!id) throw new UsageError('operator-requests show requires <id>');
  const stored = parsed.options.local === true ? api.readOperatorRequest(id) : null;
  const request = stored ? { ...stored, abandoned: api.isAbandoned(stored) } : (await readOperatorRequests({ id }))[0];
  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(request, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${detail(request, request.abandoned)}\n`);
}

/** `--pid` names the process that waits on the request; without it, the
 * process that ran this command's parent (the calling script) is the run. */
async function openRequest(parsed: ParsedCli): Promise<void> {
  const api = await requests();
  const request = api.openOperatorRequest({
    kind: textOption(parsed, 'kind'),
    account: textOption(parsed, 'account'),
    instruction: textOption(parsed, 'instruction'),
    run: textOption(parsed, 'run'),
    runPid: numberOption(parsed, 'pid') ?? process.ppid,
  });
  const paged = request.pages.some((attempt) => attempt.ok);
  if (!paged) process.exitCode = 2;
  process.stdout.write(`${detail(request, false)}\n`);
}

async function closeRequest(parsed: ParsedCli): Promise<void> {
  const api = await requests();
  const id = parsed.positional[1];
  if (!id) throw new UsageError('operator-requests close requires <id>');
  const approved = parsed.options.approved === true;
  const unapproved = parsed.options.unapproved === true;
  if (approved === unapproved) {
    throw new UsageError('operator-requests close requires exactly one of --approved or --unapproved');
  }
  const request = api.closeOperatorRequest(id, approved, textOption(parsed, 'detail'));
  process.stdout.write(`${detail(request, false)}\n`);
}

async function reopenRequest(parsed: ParsedCli): Promise<void> {
  const api = await requests();
  const id = parsed.positional[1];
  if (!id) throw new UsageError('operator-requests reopen requires <id>');
  const request = api.reopenOperatorRequest(id);
  process.stdout.write(`${detail(request, false)}\n`);
}

export async function runOperatorRequests(parsed: ParsedCli): Promise<void> {
  if (parsed.options.local !== undefined && parsed.options.local !== true) {
    throw new UsageError('--local is a flag; omit it to read the managed Weles worker');
  }
  const action = parsed.positional[0] ?? 'list';
  if (action === 'list') return listRequests(parsed);
  if (action === 'show') return showRequest(parsed);
  if (action === 'open') return openRequest(parsed);
  if (action === 'close') return closeRequest(parsed);
  if (action === 'reopen') return reopenRequest(parsed);
  throw new Error(
    `unknown operator-requests action: ${action}; weles operator-requests takes list, show, open, close or reopen`,
  );
}
