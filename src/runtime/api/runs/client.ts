import type {
  OperatorAnswer,
  OperatorRequest,
} from '../../../operator/request.mjs' with { 'resolution-mode': 'import' };
import {
  operatorJson,
  welesOperatorConnection,
  type WelesApiOptions,
} from '../connection.js';

/** The request a run waits on, as the worker observes its waiting process. */
export type WaitingRequest = OperatorRequest & { abandoned: boolean | null };

/** What a run with a live child on the worker is doing now. */
export type RunningRun = {
  run_id: string;
  action: string;
  kind: 'run' | 'reauth';
  started_at: string;
  cancel_requested: { at: string; detail: string } | null;
  last_output_at: string | null;
  stdout_tail: string;
  stderr_tail: string;
  provider?: string;
  login_item?: string | null;
  subscription_id?: string | null;
  stage?: { stage: string; at: string } | null;
  /** What the run waits for from a person; null when it waits on nobody. */
  operator_request: WaitingRequest | null;
};

/** A run's record on the worker, and what it is doing when it still runs there. */
export type ObservedRun = {
  run_id: string;
  record: Record<string, unknown> | null;
  running: RunningRun | null;
};

function parseRunning(value: unknown): RunningRun {
  const row = value as Partial<RunningRun> | null;
  if (
    !row ||
    typeof row.run_id !== 'string' ||
    typeof row.action !== 'string' ||
    typeof row.started_at !== 'string' ||
    typeof row.stdout_tail !== 'string' ||
    typeof row.stderr_tail !== 'string'
  ) {
    throw new Error('Weles returned an invalid running run');
  }
  return row as RunningRun;
}

async function exchange(
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  options: WelesApiOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const connection = welesOperatorConnection(path, options);
  try {
    const response = await connection.fetch(connection.endpoint, {
      method,
      headers: connection.headers,
      redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = await operatorJson(response);
    if (!response.ok || answer.ok !== true) {
      const said = [answer.error, answer.message]
        .filter((part) => typeof part === 'string' && part)
        .join(': ');
      throw new Error(
        `HTTP ${response.status}: ${said || 'Weles refused the request'}`,
      );
    }
    return { status: response.status, body: answer };
  } catch (cause) {
    throw new Error(
      `${method} ${connection.endpoint}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** Every run with a live child on the managed worker, oldest first. */
export async function readRunningRuns(
  options: WelesApiOptions = {},
): Promise<RunningRun[]> {
  const { body } = await exchange('/runs', 'GET', undefined, options);
  if (!Array.isArray(body.runs)) throw new Error('Weles returned no run list');
  return body.runs.map(parseRunning);
}

/** One run's record, and what it is doing when the worker still runs it. */
export async function readRun(
  runId: string,
  options: WelesApiOptions = {},
): Promise<ObservedRun> {
  const { body } = await exchange(
    `/runs/${encodeURIComponent(runId)}`,
    'GET',
    undefined,
    options,
  );
  if (body.run_id !== runId) throw new Error('Weles returned a different run');
  return {
    run_id: runId,
    record: (body.record ?? null) as Record<string, unknown> | null,
    running: body.running ? parseRunning(body.running) : null,
  };
}

/**
 * End a run the managed worker is running. `detail` says who ends it and why;
 * the run's record keeps it. A run that already finished is refused with when.
 */
export async function cancelRun(
  runId: string,
  detail: string,
  options: WelesApiOptions = {},
): Promise<RunningRun> {
  const { body } = await exchange(
    `/runs/${encodeURIComponent(runId)}/cancel`,
    'POST',
    { detail },
    options,
  );
  if (body.run_id !== runId || !body.running)
    throw new Error('Weles cancelled a different run');
  return parseRunning(body.running);
}

/**
 * Tell a run that waits for a person what the person did: `ready` (the run
 * asks the provider to send its prompt now), `approved` (the run reads the
 * page and records what the provider shows) or `not_received` (the run asks
 * the provider to send its prompt again, or ends saying it offers none). A
 * run that waits on nobody is refused with the stage it stands at.
 */
export async function answerRun(
  runId: string,
  answer: OperatorAnswer,
  detail: string,
  options: WelesApiOptions = {},
): Promise<RunningRun> {
  const { body } = await exchange(
    `/runs/${encodeURIComponent(runId)}/answer`,
    'POST',
    { answer, detail },
    options,
  );
  if (body.run_id !== runId || !body.running)
    throw new Error('Weles answered a different run');
  return parseRunning(body.running);
}
