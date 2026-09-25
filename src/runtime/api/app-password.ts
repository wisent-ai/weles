import { welesOperatorConnection, type WelesApiOptions } from './connection.js';

/** One google_app_password run as the managed executor records it. */
export type AppPasswordRun = {
  id: string;
  action: 'google_app_password';
  status: string;
  completed_at: string | null;
  params: { login_item: string };
  ok: boolean | null;
  stdout: string | null;
  error: string | null;
};

function parseRun(value: unknown): AppPasswordRun {
  const row = value as Partial<AppPasswordRun> | null;
  if (!row || typeof row !== 'object' || row.action !== 'google_app_password'
    || typeof row.id !== 'string' || typeof row.status !== 'string'
    || typeof row.params?.login_item !== 'string') throw new Error('Weles returned an unrelated app-password run');
  return row as AppPasswordRun;
}

/**
 * Start google_app_password for one Skarbiec Google login on the managed
 * executor, or read a started run back. The password itself never crosses
 * this interface: the trajectory hands it to Skrzynka on the executor's host.
 */
export async function appPasswordRun(
  input: { loginItem: string } | { runId: string }, options: WelesApiOptions = {},
): Promise<AppPasswordRun> {
  const creating = 'loginItem' in input;
  const value = (creating ? input.loginItem : input.runId).trim();
  if (!value) throw new Error(creating ? 'login_item_required' : 'run_id_required');
  const path = creating ? '/run' : `/diagnostics/${encodeURIComponent(value)}/file?path=run-result.json`;
  const connection = welesOperatorConnection(path, options);
  const operation = creating ? 'submit_app_password' : 'read_app_password_result';
  try {
    const response = await connection.fetch(connection.endpoint, {
      method: creating ? 'POST' : 'GET', headers: connection.headers, redirect: 'error',
      ...(creating ? { body: JSON.stringify({
        action: 'google_app_password', params: { login_item: value }, detached: true,
      }) } : {}),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${typeof body.error === 'string' ? body.error : 'Weles refused the app-password request'}`);
    if (creating && body.ok !== true) throw new Error('Weles did not accept the app-password request');
    const row = parseRun(creating ? {
      id: body.detached_run, action: body.action, params: body.params,
      status: 'running', completed_at: null, ok: null, stdout: null, error: null,
    } : {
      id: value, action: body.action, params: body.params, status: body.status,
      completed_at: body.completed_at ?? null, ok: typeof body.ok === 'boolean' ? body.ok : null,
      stdout: typeof body.stdout === 'string' ? body.stdout : null,
      error: body.error ?? (body.ok === false ? body.stderr_tail ?? 'App password execution failed' : null),
    });
    if (creating ? row.params.login_item !== value : row.id !== value) throw new Error('Weles returned a different app-password request');
    return row;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const detail = cause instanceof Error && cause.cause ? `: ${String(cause.cause)}` : '';
    throw new Error(`${operation} ${connection.endpoint}: ${error}${detail}`, { cause });
  }
}
