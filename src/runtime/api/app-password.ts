import {
  operatorJson,
  welesOperatorConnection,
  type WelesApiOptions,
} from './connection.js';

/** One google_app_password run as the managed executor records it. */
export type AppPasswordRun = {
  id: string;
  action: 'google_app_password';
  status: string;
  completed_at: string | null;
  params: { login_role?: string; login_item?: string; organization?: string };
  ok: boolean | null;
  stdout: string | null;
  error: string | null;
};

function parseRun(value: unknown): AppPasswordRun {
  const row = value as Partial<AppPasswordRun> | null;
  if (
    !row ||
    typeof row !== 'object' ||
    row.action !== 'google_app_password' ||
    typeof row.id !== 'string' ||
    typeof row.status !== 'string' ||
    (typeof row.params?.login_role !== 'string' &&
      typeof row.params?.login_item !== 'string')
  ) {
    // Name what came back, so a refusal says which field was missing or
    // different instead of only that the answer did not fit.
    const observed =
      row && typeof row === 'object'
        ? `action=${JSON.stringify(row.action)}, id=${JSON.stringify(row.id)}, status=${JSON.stringify(row.status)}, params=${JSON.stringify(row.params)}`
        : JSON.stringify(row);
    throw new Error(
      `Weles returned an unrelated app-password run (${observed})`,
    );
  }
  return row as AppPasswordRun;
}

/**
 * Start google_app_password by Skarbiec role or exact login item on the
 * managed executor, naming the Skrzynka organization the mailbox is declared
 * in, or read a started run back. The password itself never crosses this
 * interface: the trajectory hands it to Skrzynka on the executor's host.
 */
export async function appPasswordRun(
  input:
    | { loginRole: string; organization: string }
    | { loginItem: string; organization: string }
    | { runId: string },
  options: WelesApiOptions = {},
): Promise<AppPasswordRun> {
  const creating = !('runId' in input);
  const selector =
    'loginRole' in input
      ? 'login_role'
      : 'loginItem' in input
        ? 'login_item'
        : 'run_id';
  const value = (
    'loginRole' in input
      ? input.loginRole
      : 'loginItem' in input
        ? input.loginItem
        : input.runId
  ).trim();
  const organization = 'organization' in input ? input.organization.trim() : '';
  if (creating && !organization) throw new Error('organization_required');
  if (!value) throw new Error(`${selector}_required`);
  const path = creating
    ? '/run'
    : `/diagnostics/${encodeURIComponent(value)}/file?path=run-result.json`;
  const connection = welesOperatorConnection(path, options);
  const operation = creating
    ? 'submit_app_password'
    : 'read_app_password_result';
  try {
    const response = await connection.fetch(connection.endpoint, {
      method: creating ? 'POST' : 'GET',
      headers: connection.headers,
      redirect: 'error',
      ...(creating
        ? {
            body: JSON.stringify({
              action: 'google_app_password',
              params: { [selector]: value, organization },
              detached: true,
            }),
          }
        : {}),
    });
    const body = await operatorJson(response);
    if (!response.ok)
      throw new Error(
        `HTTP ${response.status}: ${typeof body.error === 'string' ? body.error : 'Weles refused the app-password request'}`,
      );
    if (creating && body.ok !== true)
      throw new Error('Weles did not accept the app-password request');
    const row = parseRun(
      creating
        ? {
            id: body.detached_run,
            action: body.action,
            params: body.params,
            status: 'running',
            completed_at: null,
            ok: null,
            stdout: null,
            error: null,
          }
        : {
            id: value,
            action: body.action,
            params: body.params,
            status: body.status,
            completed_at: body.completed_at ?? null,
            ok: typeof body.ok === 'boolean' ? body.ok : null,
            stdout: typeof body.stdout === 'string' ? body.stdout : null,
            error:
              body.error ??
              (body.ok === false
                ? (body.stderr_tail ?? 'App password execution failed')
                : null),
          },
    );
    if (
      selector === 'run_id' ? row.id !== value : row.params[selector] !== value
    )
      throw new Error('Weles returned a different app-password request');
    return row;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const detail =
      cause instanceof Error && cause.cause ? `: ${String(cause.cause)}` : '';
    throw new Error(`${operation} ${connection.endpoint}: ${error}${detail}`, {
      cause,
    });
  }
}
