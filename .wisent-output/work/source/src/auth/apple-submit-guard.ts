import { requireWelesDatabase } from '../utils/weles-database.js';

export type AppleAuthGuardState =
  | 'authorized'
  | 'password_submitted'
  | 'challenge_open'
  | 'closing'
  | 'closed'
  | 'failed_open';

export interface AppleAuthSubmitGuard {
  id: string;
  provider: 'apple';
  account_id: string;
  state: AppleAuthGuardState;
  expires_at: string;
  created_by: string;
  reason: string;
  execution_host: string;
  execution_agent: string;
  action_log_id: string | null;
  lease_owner: string | null;
  attempt_count: 0 | 1;
  real_password_submit_count: 0 | 1;
  authorized_at: string;
  lease_acquired_at: string | null;
  password_submitted_at: string | null;
  challenge_detected_at: string | null;
  closing_at: string | null;
  closed_at: string | null;
  observable_postcondition: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppleAuthCapabilityEnvelope {
  email: { capability_id: string; purpose: 'weles.browser.fill'; resource: 'origin:https://idmsa.apple.com/email'; target: 'weles'; authorization_id: string };
  password: { capability_id: string; purpose: 'weles.browser.fill'; resource: 'origin:https://idmsa.apple.com/password'; target: 'weles'; authorization_id: string };
  two_factor: {
    mode: 'capability';
    capability: { capability_id: string; purpose: 'weles.apple.2fa'; resource: string; target: 'weles'; authorization_id: string };
  };
}

const STATES: readonly AppleAuthGuardState[] = [
  'authorized',
  'password_submitted',
  'challenge_open',
  'closing',
  'closed',
  'failed_open',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RPC_TIMEOUT_MS = 15_000;

function requireUuid(value: string, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(`${name} must be a valid UUID`);
  return value.toLowerCase();
}

function requireText(value: string, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`${name} must contain 1 to ${max} characters`);
  }
  return value.trim();
}

function serviceConfiguration(): { url: string; key: string } {
  const database = requireWelesDatabase();
  return { url: database.url, key: database.token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRpcRow(payload: unknown, rpcName: string): AppleAuthSubmitGuard {
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) {
    throw new Error(`Apple auth guard RPC ${rpcName} returned no unique guard row`);
  }
  const row = payload[0];
  if (
    typeof row.id !== 'string' || !UUID_PATTERN.test(row.id)
    || row.provider !== 'apple'
    || typeof row.account_id !== 'string' || !UUID_PATTERN.test(row.account_id)
    || !STATES.includes(row.state as AppleAuthGuardState)
    || typeof row.expires_at !== 'string'
    || typeof row.execution_host !== 'string' || !row.execution_host
    || typeof row.execution_agent !== 'string' || !row.execution_agent
    || (row.action_log_id !== null && (typeof row.action_log_id !== 'string' || !UUID_PATTERN.test(row.action_log_id)))
    || (row.lease_owner !== null && typeof row.lease_owner !== 'string')
    || (row.attempt_count !== 0 && row.attempt_count !== 1)
    || (row.real_password_submit_count !== 0 && row.real_password_submit_count !== 1)
    || row.attempt_count !== row.real_password_submit_count
  ) {
    throw new Error(`Apple auth guard RPC ${rpcName} returned an invalid guard row`);
  }
  return row as unknown as AppleAuthSubmitGuard;
}

async function callGuardRpc(rpcName: string, body: Record<string, string>): Promise<AppleAuthSubmitGuard> {
  const { url, key } = serviceConfiguration();
  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown transport error';
    throw new Error(`Apple auth guard RPC ${rpcName} failed closed: ${message}`);
  }
  if (!response.ok) throw new Error(`Apple auth guard RPC ${rpcName} failed closed (HTTP ${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error(`Apple auth guard RPC ${rpcName} returned invalid JSON`); }
  return requireRpcRow(payload, rpcName);
}

export async function getAppleAuthCapabilityEnvelope(
  guardId: string,
  accountId: string,
  actionLogId: string,
): Promise<AppleAuthCapabilityEnvelope> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAccount = requireUuid(accountId, 'accountId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const { url, key } = serviceConfiguration();
  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/get_apple_auth_capability_envelope`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_guard_id: expectedGuard,
        p_account_id: expectedAccount,
        p_action_log_id: expectedAction,
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown transport error';
    throw new Error(`Apple capability envelope RPC failed closed: ${message}`);
  }
  if (!response.ok) throw new Error(`Apple capability envelope RPC failed closed (HTTP ${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error('Apple capability envelope RPC returned invalid JSON'); }
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])
      || Object.keys(payload[0]).sort().join(',') !== 'email_capability_id,password_capability_id,two_factor_capability_id') {
    throw new Error('Apple capability envelope RPC returned an invalid row');
  }
  const row = payload[0];
  const ids = [row.email_capability_id, row.password_capability_id, row.two_factor_capability_id];
  if (!ids.every((value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
      || new Set(ids).size !== 3) {
    throw new Error('Apple capability envelope RPC returned invalid capability identifiers');
  }
  return {
    email: {
      capability_id: row.email_capability_id as string,
      purpose: 'weles.browser.fill',
      resource: 'origin:https://idmsa.apple.com/email',
      target: 'weles',
      authorization_id: expectedGuard,
    },
    password: {
      capability_id: row.password_capability_id as string,
      purpose: 'weles.browser.fill',
      resource: 'origin:https://idmsa.apple.com/password',
      target: 'weles',
      authorization_id: expectedGuard,
    },
    two_factor: {
      mode: 'capability',
      capability: {
        capability_id: row.two_factor_capability_id as string,
        purpose: 'weles.apple.2fa',
        resource: `challenge:apple/${expectedGuard}`,
        target: 'weles',
        authorization_id: expectedGuard,
      },
    },
  };
}

function assertIdentity(
  guard: AppleAuthSubmitGuard,
  guardId: string,
  accountId?: string,
  actionLogId?: string,
): void {
  if (guard.id.toLowerCase() !== guardId.toLowerCase()) throw new Error('Apple auth guard ID mismatch');
  if (accountId && guard.account_id.toLowerCase() !== accountId.toLowerCase()) throw new Error('Apple auth account mismatch');
  if (actionLogId && guard.action_log_id?.toLowerCase() !== actionLogId.toLowerCase()) throw new Error('Apple auth action mismatch');
}

export async function claimAppleAuthAuthorization(
  guardId: string,
  accountId: string,
  actionLogId: string,
  executionHost: string,
  executionAgent: string,
  leaseOwner: string,
): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAccount = requireUuid(accountId, 'accountId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const host = requireText(executionHost, 'executionHost', 253);
  const agent = requireText(executionAgent, 'executionAgent', 200);
  const lease = requireText(leaseOwner, 'leaseOwner', 500);
  const guard = await callGuardRpc('claim_apple_auth_submit_guard', {
    p_guard_id: expectedGuard,
    p_account_id: expectedAccount,
    p_action_log_id: expectedAction,
    p_execution_host: host,
    p_execution_agent: agent,
    p_lease_owner: lease,
  });
  assertIdentity(guard, expectedGuard, expectedAccount, expectedAction);
  if (guard.state !== 'authorized' || guard.attempt_count !== 0 || guard.lease_owner !== lease
      || guard.execution_host !== host || guard.execution_agent !== agent) {
    throw new Error('Apple auth claim validation failed closed');
  }
  return guard;
}

export async function assertAppleAuthChallengeOpen(
  guardId: string,
  accountId: string,
  actionLogId: string,
): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAccount = requireUuid(accountId, 'accountId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const guard = await callGuardRpc('assert_apple_auth_challenge_open', {
    p_guard_id: expectedGuard,
    p_account_id: expectedAccount,
    p_action_log_id: expectedAction,
  });
  assertIdentity(guard, expectedGuard, expectedAccount, expectedAction);
  if (guard.state !== 'challenge_open' || guard.attempt_count !== 1) {
    throw new Error('Apple challenge is not durably open');
  }
  return guard;
}

export async function consumeAppleAuthAuthorization(
  guardId: string,
  accountId: string,
  actionLogId: string,
  leaseOwner: string,
): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAccount = requireUuid(accountId, 'accountId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const lease = requireText(leaseOwner, 'leaseOwner', 500);
  const guard = await callGuardRpc('consume_apple_auth_submit_guard', {
    p_guard_id: expectedGuard,
    p_account_id: expectedAccount,
    p_action_log_id: expectedAction,
    p_lease_owner: lease,
  });
  assertIdentity(guard, expectedGuard, expectedAccount, expectedAction);
  if (guard.state !== 'password_submitted' || guard.attempt_count !== 1
      || guard.real_password_submit_count !== 1 || guard.lease_owner !== lease) {
    throw new Error('Apple auth consumption validation failed closed');
  }
  return guard;
}

export async function markAppleAuthChallengeOpen(guardId: string, actionLogId: string): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const guard = await callGuardRpc('mark_apple_auth_challenge_open', {
    p_guard_id: expectedGuard, p_action_log_id: expectedAction,
  });
  assertIdentity(guard, expectedGuard, undefined, expectedAction);
  if (guard.state !== 'challenge_open' || guard.attempt_count !== 1) throw new Error('Apple challenge transition failed closed');
  return guard;
}

export async function recordAppleAuthChallengeCaptured(guardId: string, actionLogId: string): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const guard = await callGuardRpc('record_apple_auth_challenge_captured', {
    p_guard_id: expectedGuard, p_action_log_id: expectedAction,
  });
  assertIdentity(guard, expectedGuard, undefined, expectedAction);
  if (guard.state !== 'challenge_open') throw new Error('Apple challenge capture audit failed closed');
  return guard;
}

export async function recordAppleAuthChallengeRedeemed(guardId: string, actionLogId: string): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const guard = await callGuardRpc('record_apple_auth_challenge_redeemed', {
    p_guard_id: expectedGuard, p_action_log_id: expectedAction,
  });
  assertIdentity(guard, expectedGuard, undefined, expectedAction);
  if (guard.state !== 'challenge_open') throw new Error('Apple challenge redeem audit failed closed');
  return guard;
}

export async function beginAppleAuthClosing(guardId: string, actionLogId: string): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const guard = await callGuardRpc('begin_apple_auth_closing', {
    p_guard_id: expectedGuard, p_action_log_id: expectedAction,
  });
  assertIdentity(guard, expectedGuard, undefined, expectedAction);
  if (guard.state !== 'closing') throw new Error('Apple closing transition failed closed');
  return guard;
}

export async function closeAppleAuthAuthorization(
  guardId: string,
  actionLogId: string,
  observablePostcondition: string,
): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const postcondition = requireText(observablePostcondition, 'observablePostcondition', 4000);
  const guard = await callGuardRpc('close_apple_auth_submit_guard', {
    p_guard_id: expectedGuard,
    p_action_log_id: expectedAction,
    p_observable_postcondition: postcondition,
  });
  assertIdentity(guard, expectedGuard, undefined, expectedAction);
  if (guard.state !== 'closed' || guard.attempt_count !== 1 || guard.observable_postcondition !== postcondition) {
    throw new Error('Apple confirmed closure validation failed closed');
  }
  return guard;
}

export async function markAppleAuthFailedOpen(
  guardId: string,
  actionLogId: string,
  reason: string,
): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const failure = requireText(reason, 'reason', 4000);
  const guard = await callGuardRpc('fail_open_apple_auth_submit_guard', {
    p_guard_id: expectedGuard, p_action_log_id: expectedAction, p_reason: failure,
  });
  assertIdentity(guard, expectedGuard, undefined, expectedAction);
  if (guard.state !== 'failed_open' || guard.attempt_count !== 1) throw new Error('Apple failed_open transition failed');
  return guard;
}

export async function markAppleAuthFailedOpenByActionLog(actionLogId: string, reason: string): Promise<AppleAuthSubmitGuard | null> {
  const expectedAction = requireUuid(actionLogId, 'actionLogId');
  const failure = requireText(reason, 'reason', 4000);
  const { url, key } = serviceConfiguration();
  const response = await fetch(`${url}/rest/v1/rpc/fail_open_apple_auth_by_action_log`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_action_log_id: expectedAction, p_reason: failure }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  }).catch((error: unknown) => { throw new Error(`Apple zombie fail-open RPC failed: ${error instanceof Error ? error.message : 'transport error'}`); });
  if (!response.ok) throw new Error(`Apple zombie fail-open RPC failed (HTTP ${response.status})`);
  const payload: unknown = await response.json().catch(() => { throw new Error('Apple zombie fail-open RPC returned invalid JSON'); });
  if (Array.isArray(payload) && payload.length === 0) return null;
  const guard = requireRpcRow(payload, 'fail_open_apple_auth_by_action_log');
  if (guard.action_log_id?.toLowerCase() !== expectedAction || guard.state !== 'failed_open') {
    throw new Error('Apple zombie fail-open validation failed');
  }
  return guard;
}

export async function cancelAppleAuthAuthorization(guardId: string, reason: string): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const cancellation = requireText(reason, 'reason', 4000);
  const guard = await callGuardRpc('cancel_apple_auth_submit_guard', {
    p_guard_id: expectedGuard, p_reason: cancellation,
  });
  assertIdentity(guard, expectedGuard);
  if (guard.state !== 'closed' || guard.attempt_count !== 0) throw new Error('Apple authorization cancellation failed closed');
  return guard;
}

export async function resolveAppleAuthFailedOpen(
  guardId: string,
  confirmedPostcondition: string,
): Promise<AppleAuthSubmitGuard> {
  const expectedGuard = requireUuid(guardId, 'guardId');
  const postcondition = requireText(confirmedPostcondition, 'confirmedPostcondition', 4000);
  const guard = await callGuardRpc('resolve_apple_auth_failed_open', {
    p_guard_id: expectedGuard,
    p_confirmed_postcondition: postcondition,
  });
  assertIdentity(guard, expectedGuard);
  if (guard.state !== 'closed' || guard.attempt_count !== 1
      || guard.observable_postcondition !== postcondition || guard.failure_reason !== null) {
    throw new Error('Apple failed-open resolution validation failed closed');
  }
  return guard;
}
