// Start one Weles action through the Weles API's own execution path.
//
// Recoveries, top-ups, follow-ups and notifications that one run asks for are
// started as a detached POST /run on the Weles API of this host: the API runs
// the trajectory, persists its result under the detached run id and serves it
// through GET /diagnostics/<run id>, so the id returned here names a run whose
// terminal state can be read. The earlier Stado submission ran a runner file no
// Weles revision ships, so its job ids named nothing that could execute.
//
// The endpoint is the API this process belongs to (WELES_API_PORT on loopback),
// or WELES_WORKER_API_BASE when the caller runs off-host; with neither set the
// run is refused by name, since no port is built in. The bearer is the API
// token the process was started with. A missing token is refused by name.

const SAFE_ACTION = /^[a-z][a-z0-9_]{0,127}$/;
// An account item's id is random and means nothing; only its shape is checked.
const ACCOUNT_ITEM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;
const QUOTED_BODY_CHARS = 300;
const BODY_START = 0;

export interface WelesRunRequest {
  action: string;
  accountItem?: string;
  params?: Record<string, unknown>;
}

function apiBase(): string {
  const configured = process.env.WELES_WORKER_API_BASE?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const port = process.env.WELES_API_PORT?.trim();
  if (!port) {
    throw new Error('cannot start a Weles run: neither WELES_WORKER_API_BASE nor WELES_API_PORT is set in this process');
  }
  return `http://127.0.0.1:${port}`;
}

function apiToken(): string {
  const token = process.env.WELES_API_TOKEN || process.env.WELES_CONSOLE_API_TOKEN || process.env.WELES_WORKER_TOKEN || '';
  if (!token) {
    throw new Error('cannot start a Weles run: none of WELES_API_TOKEN, WELES_CONSOLE_API_TOKEN, WELES_WORKER_TOKEN is set in this process');
  }
  return token;
}

/** Start `action` detached on the Weles API and return its run id. */
export async function submitWelesRun(request: WelesRunRequest): Promise<string> {
  if (!SAFE_ACTION.test(request.action)) throw new Error(`invalid Weles action: ${request.action}`);
  if (request.accountItem && !ACCOUNT_ITEM.test(request.accountItem)) {
    throw new Error('accountItem must be an exact Weles Skarbiec item id');
  }
  const params = request.params ?? {};
  if (Array.isArray(params) || typeof params !== 'object') throw new Error('params must be an object');
  const endpoint = `${apiBase()}/run`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: request.action,
      ...(request.accountItem ? { account_id: request.accountItem } : {}),
      params,
      detached: true,
    }),
  });
  const text = await response.text();
  let answer: { ok?: boolean; detached_run?: string; error?: string };
  try {
    answer = JSON.parse(text);
  } catch (error) {
    throw new Error(`${endpoint} answered HTTP ${response.status} with a body that is not JSON (${(error as Error).message}): ${text.slice(BODY_START, QUOTED_BODY_CHARS)}`);
  }
  if (!response.ok || !answer.ok || !answer.detached_run) {
    throw new Error(`${endpoint} refused ${request.action}: HTTP ${response.status} ${answer.error ?? text.slice(BODY_START, QUOTED_BODY_CHARS)}`);
  }
  return answer.detached_run;
}

const HTTP_NOT_FOUND = 404;

/**
 * The persisted result of one detached run (GET /diagnostics/<run id>/file?path=run-result.json),
 * or null while the API has no result file for that run.
 */
export async function readWelesRun<T>(runId: string): Promise<T | null> {
  const endpoint = `${apiBase()}/diagnostics/${encodeURIComponent(runId)}/file?path=run-result.json`;
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${apiToken()}` } });
  if (response.status === HTTP_NOT_FOUND) return null;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${endpoint} answered HTTP ${response.status}: ${text.slice(BODY_START, QUOTED_BODY_CHARS)}`);
  }
  return JSON.parse(text) as T;
}
