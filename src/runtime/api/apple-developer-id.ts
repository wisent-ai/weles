import { operatorJson, welesOperatorConnection, type WelesApiOptions } from './connection.js';

/** What one create_developer_id run needs from its caller. */
export type DeveloperIdRequest = {
  accountItem: string;
  guardId: string;
  executionHost: string;
  executionAgent: string;
  capabilities: unknown;
  csrBase64: string;
};

/** One create_developer_id run as the managed executor records it. */
export type DeveloperIdRun = {
  id: string;
  status: string;
  ok: boolean | null;
  stdout: string | null;
  error: string | null;
};

async function exchange(path: string, method: 'GET' | 'POST', body: string | undefined, operation: string, options: WelesApiOptions) {
  const connection = welesOperatorConnection(path, options);
  try {
    const response = await connection.fetch(connection.endpoint, { method, headers: connection.headers, redirect: 'error', body });
    const answer = await operatorJson(response);
    if (!response.ok) {
      throw new Error([`HTTP ${response.status}`, optionalText(answer.error)].filter(Boolean).join(': '));
    }
    return answer;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${operation} ${connection.endpoint}: ${error}`, { cause });
  }
}

function optionalText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return null;
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

/** Start create_developer_id detached on the managed executor; the answer is its run id. */
export async function startDeveloperIdRun(request: DeveloperIdRequest, options: WelesApiOptions = {}): Promise<string> {
  const answer = await exchange('/run', 'POST', JSON.stringify({
    action: 'apple_create_developer_id',
    params: {
      login_item: request.accountItem,
      apple_auth_guard_id: request.guardId,
      apple_execution_host: request.executionHost,
      apple_execution_agent: request.executionAgent,
      apple_login_capabilities: request.capabilities,
      apple_csr_base64: request.csrBase64,
    },
    detached: true,
  }), 'submit_apple_developer_id', options);
  if (answer.ok !== true || typeof answer.detached_run !== 'string') {
    throw new Error('submit_apple_developer_id: Weles did not accept the run');
  }
  return answer.detached_run;
}

/** Read a started create_developer_id run back. */
export async function readDeveloperIdRun(runId: string, options: WelesApiOptions = {}): Promise<DeveloperIdRun> {
  const id = runId.trim();
  if (!id) throw new Error('run_id_required');
  const answer = await exchange(
    `/diagnostics/${encodeURIComponent(id)}/file?path=run-result.json`,
    'GET',
    undefined,
    'read_apple_developer_id_result',
    options,
  );
  if (typeof answer.status !== 'string') {
    throw new Error(`read_apple_developer_id_result: run ${id} result carries no status`);
  }
  let error = optionalText(answer.error);
  if (!error && answer.ok === false) error = optionalText(answer.stderr_tail);
  return { id, status: answer.status, ok: optionalBoolean(answer.ok), stdout: optionalText(answer.stdout), error };
}
