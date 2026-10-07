// `weles runs` — the runs the managed worker is running, what each waits for,
// and acting on one.
//
// A browser run waits until the page answers, and a page that never answers
// keeps it waiting with nothing to say so: its record still shows the last
// stage it reached. Some pages wait for a person — a Google phone approval, a
// bank verification — and the run then names what it asked for. A sign-in is
// coalesced per account, so such a run also holds every later sign-in of that
// account. `list` shows each live run with how long ago it last wrote anything
// and what it waits for, `show` prints what it wrote last, `answer` tells a
// run waiting for a person what the person did, and `cancel` ends a run so the
// next run of that account starts fresh.

import type { ParsedCli } from '../../cli.js';
import { UsageError } from '../usage.js';
import {
  answerRun, cancelRun, readRun, readRunningRuns, type RunningRun, type WaitingRequest,
} from '../../runtime/api/runs/client.js';
import type { OperatorAnswer } from '../../operator/request.mjs' with { 'resolution-mode': 'import' };

function silence(lastOutputAt: string | null, startedAt: string): string {
  const since = Date.parse(lastOutputAt ?? startedAt);
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return lastOutputAt ? `last wrote ${seconds}s ago` : `wrote nothing in ${seconds}s`;
}

/** Whether the person was told, and whether the waiting process still runs. */
function waitingState(request: WaitingRequest): string {
  const paged = request.pages.some((attempt) => attempt.ok) ? 'paged' : 'not paged';
  const waiting = request.abandoned === true ? 'its process has ended' : request.abandoned === false ? 'waiting' : 'process state unknown';
  return `${paged}, ${waiting}`;
}

function summarise(run: RunningRun): string {
  const subject = run.kind === 'reauth'
    ? `${run.provider ?? '-'} ${run.login_item ?? '-'} at ${run.stage?.stage ?? 'no stage yet'}`
    : run.action;
  return [
    run.run_id,
    run.kind,
    subject,
    `started ${run.started_at}`,
    silence(run.last_output_at, run.started_at),
    run.operator_request ? `WAITS FOR YOU: ${run.operator_request.instruction} (${waitingState(run.operator_request)})` : '',
    run.cancel_requested ? `cancel requested ${run.cancel_requested.at}` : '',
  ].filter(Boolean).join('  ');
}

function detail(run: RunningRun): string {
  const lines = [
    `run          ${run.run_id}`,
    `action       ${run.action} (${run.kind})`,
    `started      ${run.started_at}`,
    `output       ${silence(run.last_output_at, run.started_at)}`,
  ];
  if (run.kind === 'reauth') {
    lines.push(`account      ${run.provider ?? '-'} ${run.login_item ?? '-'} (subscription ${run.subscription_id ?? '-'})`);
    lines.push(`stage        ${run.stage ? `${run.stage.stage} since ${run.stage.at}` : 'none reached yet'}`);
  }
  const request = run.operator_request;
  if (request) {
    lines.push(`waits for    ${request.instruction}`);
    lines.push(`asked        ${request.kind} for ${request.account} on ${request.host} since ${request.opened_at} (${waitingState(request)})`);
    for (const attempt of request.pages) lines.push(`page         ${attempt.at} ${attempt.ok ? 'delivered' : 'not delivered'}: ${attempt.detail}`);
    for (const said of request.answers ?? []) lines.push(`answered     ${said.at} ${said.answer}${said.detail ? `: ${said.detail}` : ''}`);
    for (const note of request.notes ?? []) lines.push(`run noted    ${note.at} ${note.note}`);
    lines.push(`answer it    weles runs answer ${run.run_id} --ready | --approved | --not-received [--detail <text>]`);
  }
  if (run.cancel_requested) lines.push(`cancelled    ${run.cancel_requested.at}: ${run.cancel_requested.detail}`);
  for (const [stream, text] of [['stderr', run.stderr_tail], ['stdout', run.stdout_tail]]) {
    for (const line of text.split('\n').filter((written) => written.trim()).slice(-12)) {
      lines.push(`${stream.padEnd(13)}${line}`);
    }
  }
  lines.push(`cancel it    weles runs cancel ${run.run_id} --detail <who and why>`);
  return lines.join('\n');
}

function recordDetail(runId: string, record: Record<string, unknown> | null): string {
  if (!record) return `run          ${runId}\nrecord       none on the worker`;
  const failure = record.failure as { code?: string; message?: string } | null | undefined;
  const lines = [
    `run          ${runId}`,
    `action       ${String(record.action ?? '-')}`,
    `status       ${String(record.status ?? '-')}${record.status === 'running' ? ' (no live child on this worker: the server that ran it stopped)' : ''}`,
    `started      ${String(record.started_at ?? '-')}`,
    `completed    ${String(record.completed_at ?? '-')}`,
  ];
  if (record.status === 'finished') lines.push(`ok           ${String(record.ok)}`);
  if (failure?.code) lines.push(`failure      ${failure.code}${failure.message ? `: ${failure.message}` : ''}`);
  if (record.cancel_detail) lines.push(`cancelled    ${String(record.cancel_detail)}`);
  return lines.join('\n');
}

async function listRuns(parsed: ParsedCli): Promise<void> {
  const runs = await readRunningRuns();
  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
    return;
  }
  if (runs.length === 0) {
    process.stdout.write('no runs are running on the selected Weles worker\n');
    return;
  }
  for (const run of runs) process.stdout.write(`${summarise(run)}\n`);
}

async function showRun(parsed: ParsedCli): Promise<void> {
  const id = parsed.positional[1];
  if (!id) throw new UsageError('runs show requires <run-id>');
  const observed = await readRun(id);
  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(observed, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${observed.running ? detail(observed.running) : recordDetail(id, observed.record)}\n`);
}

async function cancel(parsed: ParsedCli): Promise<void> {
  const id = parsed.positional[1];
  if (!id) throw new UsageError('runs cancel requires <run-id>');
  const said = typeof parsed.options.detail === 'string' ? parsed.options.detail.trim() : '';
  if (!said) throw new UsageError('runs cancel requires --detail <who cancels it and why>');
  const run = await cancelRun(id, said);
  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${detail(run)}\n`);
}

/** Each answer flag and the answer it sends, in the order usage names them. */
const ANSWER_FLAGS: ReadonlyArray<{ flag: string; answer: OperatorAnswer }> = [
  { flag: 'ready', answer: 'ready' },
  { flag: 'approved', answer: 'approved' },
  { flag: 'not-received', answer: 'not_received' },
];

/**
 * Tell a run waiting for a person what the person did. `--ready`: the phone
 * is in hand, so the run asks the provider to send its prompt now (a run
 * sends none before). `--approved`: the run reads the page and records what
 * the provider shows. `--not-received`: the run asks the provider to send its
 * prompt again, or ends saying it offers no second send. Ending the wait is
 * `cancel`.
 */
async function answer(parsed: ParsedCli): Promise<void> {
  const id = parsed.positional[1];
  if (!id) throw new UsageError('runs answer requires <run-id>');
  const [chosen, ...more] = ANSWER_FLAGS.filter(({ flag }) => parsed.options[flag] === true);
  if (!chosen || more.length) {
    throw new UsageError('runs answer requires exactly one of --ready, --approved or --not-received; ending the wait is weles runs cancel <run-id> --detail <who and why>');
  }
  if (parsed.options.detail !== undefined && typeof parsed.options.detail !== 'string') {
    throw new UsageError('runs answer --detail requires <text>');
  }
  const said = typeof parsed.options.detail === 'string' ? parsed.options.detail.trim() : '';
  const run = await answerRun(id, chosen.answer, said);
  if (parsed.options.json === true) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${detail(run)}\n`);
}

export async function runRuns(parsed: ParsedCli): Promise<void> {
  const action = parsed.positional[0] ?? 'list';
  if (action === 'list') return listRuns(parsed);
  if (action === 'show') return showRun(parsed);
  if (action === 'answer') return answer(parsed);
  if (action === 'cancel') return cancel(parsed);
  throw new UsageError(`unknown runs action: ${action}; weles runs takes list, show, answer or cancel`);
}
