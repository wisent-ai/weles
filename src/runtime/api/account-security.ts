import { randomUUID } from 'node:crypto';
import { welesApiConnection, type WelesApiOptions } from './connection.js';

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
  const connection = welesApiConnection(creating ? '/api/v1/runs' : `/api/v1/runs/${encodeURIComponent(value)}`, options);
  const response = await connection.fetch(connection.endpoint, {
    method: creating ? 'POST' : 'GET', headers: connection.headers, redirect: 'error',
    ...(creating ? { body: JSON.stringify({
      action: 'google_mfa_status', params: { login_item: value }, idempotency_key: randomUUID(),
    }) } : {}),
  });
  const body = await response.json() as { row?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error || `Weles account-security request failed with HTTP ${response.status}`);
  const row = parseRun(creating ? body.row : body);
  if (creating ? row.params.login_item !== value : row.id !== value) throw new Error('Weles returned a different account-security request');
  return row;
}
