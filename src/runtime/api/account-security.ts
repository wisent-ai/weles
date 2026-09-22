import { welesOperatorConnection, type WelesApiOptions } from './connection.js';

export type AccountSecurityResult = {
  schema: 'weles.account-security.v1';
  ok: boolean;
  provider: 'google';
  login_item: string;
  account: string | null;
  two_factor_enabled: boolean | null;
  checked_at: string;
  reason: string | null;
  status_evidence?: string;
  account_evidence?: string;
  url?: string;
  error?: string;
  operation?: string;
  source_revision: string;
};

export type AccountSecurityRun = {
  id: string;
  action: 'google_mfa_status';
  status: string;
  completed_at: string | null;
  params: { login_item: string };
  result: AccountSecurityResult | null;
  error: string | null;
};

function parseRun(value: unknown): AccountSecurityRun {
  const row = value as Partial<AccountSecurityRun> | null;
  if (!row || typeof row !== 'object' || row.action !== 'google_mfa_status'
    || typeof row.id !== 'string' || typeof row.status !== 'string'
    || typeof row.params?.login_item !== 'string') throw new Error('Weles returned an unrelated account-security run');
  if (row.result !== null && row.result !== undefined) {
    const result = row.result;
    if (result.schema !== 'weles.account-security.v1' || result.provider !== 'google'
      || result.login_item !== row.params.login_item
      || typeof result.source_revision !== 'string'
      || (result.account !== null && typeof result.account !== 'string')
      || typeof result.ok !== 'boolean'
      || (result.two_factor_enabled !== null && typeof result.two_factor_enabled !== 'boolean')
      || result.ok !== (typeof result.two_factor_enabled === 'boolean')
      || typeof result.checked_at !== 'string') throw new Error('Weles returned an invalid 2FA observation');
  }
  return { ...row, result: row.result ?? null } as AccountSecurityRun;
}

export async function accountSecurityRun(
  input: { loginItem: string } | { runId: string }, options: WelesApiOptions = {},
): Promise<AccountSecurityRun> {
  const creating = 'loginItem' in input;
  const value = (creating ? input.loginItem : input.runId).trim();
  if (!value) throw new Error(creating ? 'login_item_required' : 'run_id_required');
  const path = creating ? '/run' : `/diagnostics/${encodeURIComponent(value)}/file?path=run-result.json`;
  const connection = welesOperatorConnection(path, options);
  const operation = creating ? 'submit_account_security' : 'read_account_security_result';
  try {
    const response = await connection.fetch(connection.endpoint, {
      method: creating ? 'POST' : 'GET', headers: connection.headers, redirect: 'error',
      ...(creating ? { body: JSON.stringify({
        action: 'google_mfa_status', params: { login_item: value }, detached: true,
      }) } : {}),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${typeof body.error === 'string' ? body.error : 'Weles refused the account-security request'}`);
    if (creating && body.ok !== true) throw new Error('Weles did not accept the account-security request');
    const row = parseRun(creating ? {
      id: body.detached_run, action: body.action, params: body.params,
      status: 'running', completed_at: null, result: null, error: null,
    } : {
      id: value, action: body.action, params: body.params, status: body.status,
      completed_at: body.completed_at ?? null, result: body.result ?? null,
      error: body.error ?? (body.ok === false ? body.stderr_tail ?? 'Account security execution failed' : null),
    });
    if (creating ? row.params.login_item !== value : row.id !== value) throw new Error('Weles returned a different account-security request');
    return row;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const detail = cause instanceof Error && cause.cause ? `: ${String(cause.cause)}` : '';
    throw new Error(`${operation} ${connection.endpoint}: ${error}${detail}`, { cause });
  }
}
