import { requireWelesDatabase, welesDatabaseHeaders } from '../utils/weles-database.js';

export type JsonObject = Record<string, unknown>;
type QueryValue = string | number | boolean | null;
export type ActivityPlatform = 'reddit' | 'instagram' | 'tiktok';
export type ActionLogPattern = 'topup' | 'register_or_baseline' | 'exclude_health';
export type ActionLogTimeField = 'started_at' | 'completed_at' | 'claimed_at';
export type AccountListOptions = {
  platform?: string;
  ids?: string[];
  statuses?: string[];
  activeOnly?: boolean;
  ascending?: boolean;
  limit: number;
};
export type ActionLogQuery = {
  accountIds?: string[];
  accountId?: string;
  statuses?: string[];
  action?: string;
  pattern?: ActionLogPattern;
  since?: string;
  until?: string;
  sinceField?: ActionLogTimeField;
  ascending?: boolean;
  limit: number;
};
export type HealthSnapshotQuery = {
  accountIds?: string[];
  accountId?: string;
  since?: string;
  ascending?: boolean;
  limit: number;
};

const ZERO = Number('0');
const ONE = Number('1');
const HTTP_NO_CONTENT = Number('204');
const ERROR_DETAIL_LIMIT = Number('500');
const DEFAULT_LIST_LIMIT = Number('50');
const MAX_ACCOUNT_LIMIT = Number('500');
const MAX_JOB_LIMIT = Number('100');
const FIVE_MINUTES_MS = Number('300000');
const POLL_INTERVAL_SECONDS = Number('5');
const MAX_EVENT_LIMIT = Number('500');
const DUE_ITEM_LIMIT = Number('20');
const RECENT_ACTION_LIMIT = Number('2000');
const MAX_ANALYTICS_LIMIT = Number('5000');
const ACTIVITY_PROFILE_TABLE: Record<ActivityPlatform, string> = {
  reddit: 'reddit_activity_profiles',
  instagram: 'instagram_activity_profiles',
  tiktok: 'tiktok_activity_profiles',
};

function queryString(query: Record<string, QueryValue | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

async function rest<T>(
  table: string,
  query: Record<string, QueryValue | undefined>,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; single?: boolean; prefer?: string } = {},
): Promise<T> {
  const credentials = requireWelesDatabase();
  const suffix = queryString(query);
  const response = await fetch(`${credentials.url}/rest/v1/${table}${suffix ? `?${suffix}` : ''}`, {
    method: init.method ?? 'GET',
    headers: welesDatabaseHeaders(credentials, {
      Accept: init.single ? 'application/vnd.pgrst.object+json' : 'application/json',
      'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    }),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(ZERO, ERROR_DETAIL_LIMIT);
    throw new Error(`Weles data operation failed (${response.status}): ${detail}`);
  }
  if (response.status === HTTP_NO_CONTENT) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listAccountActionLogs(accountId: string, limit = DEFAULT_LIST_LIMIT) {
  return rest<JsonObject[]>('account_action_logs', {
    select: 'id,account_id,action,platform,status,result,error,started_at,completed_at,claimed_by,scheduled_at',
    account_id: `eq.${accountId}`,
    order: 'started_at.desc',
    limit,
  });
}

export async function getAccount(accountId: string) {
  const rows = await rest<JsonObject[]>('social_accounts', {
    select: '*',
    id: `eq.${accountId}`,
    limit: ONE,
  });
  return rows.at(ZERO) ?? null;
}

export async function getAccountByPlatformUsername(platform: string, username: string) {
  const rows = await rest<JsonObject[]>('social_accounts', {
    select: '*',
    platform: `eq.${platform}`,
    username: `eq.${username}`,
    limit: ONE,
  });
  return rows.at(ZERO) ?? null;
}

export async function listAccounts(platform: string, ids?: string[], mode: 'active' | 'probe' = 'active') {
  return rest<JsonObject[]>('social_accounts', {
    select: 'id,username,platform,lifecycle_phase,paused_until,created_at,status,is_active',
    platform: `eq.${platform}`,
    is_active: 'eq.true',
    ...(ids?.length ? { id: `in.(${ids.join(',')})` } : {}),
    ...(mode === 'probe' ? { status: 'in.(active,login_required)' } : { status: 'eq.active' }),
    order: 'created_at.asc',
    limit: MAX_ACCOUNT_LIMIT,
  });
}

export async function queryAccounts(input: AccountListOptions) {
  if (input.ids && !input.ids.length) return [];
  return rest<JsonObject[]>('social_accounts', {
    select: '*',
    ...(input.platform ? { platform: `eq.${input.platform}` } : {}),
    ...(input.ids?.length ? { id: `in.(${input.ids.join(',')})` } : {}),
    ...(input.statuses?.length ? { status: `in.(${input.statuses.join(',')})` } : {}),
    ...(input.activeOnly ? { is_active: 'eq.true' } : {}),
    order: `created_at.${input.ascending ? 'asc' : 'desc'}`,
    limit: Math.min(input.limit, MAX_ANALYTICS_LIMIT),
  });
}

export async function upsertAccount(row: JsonObject) {
  const rows = await rest<JsonObject[]>('social_accounts', { on_conflict: 'platform,username', select: '*' }, {
    method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=representation',
  });
  return rows.at(ZERO) ?? null;
}

export async function updateAccount(accountId: string, patch: JsonObject) {
  const rows = await rest<JsonObject[]>('social_accounts', { id: `eq.${accountId}`, select: '*' }, {
    method: 'PATCH', body: patch, prefer: 'return=representation',
  });
  return rows.at(ZERO) ?? null;
}

export async function deleteAccount(accountId: string) {
  await rest('social_accounts', { id: `eq.${accountId}` }, {
    method: 'DELETE', prefer: 'return=minimal',
  });
}

export async function queryActionLogs(input: ActionLogQuery) {
  if (input.accountIds && !input.accountIds.length) return [];
  const timeField = input.sinceField ?? 'started_at';
  const pattern = input.pattern === 'topup' ? 'like.*_topup'
    : input.pattern === 'exclude_health' ? 'not.like.*_health'
      : undefined;
  return rest<JsonObject[]>('account_action_logs', {
    select: 'id,account_id,action,platform,status,params,result,error,started_at,completed_at,claimed_at,claimed_by,scheduled_at,service_costs',
    ...(input.accountIds?.length ? { account_id: `in.(${input.accountIds.join(',')})` } : {}),
    ...(input.accountId ? { account_id: `eq.${input.accountId}` } : {}),
    ...(input.statuses?.length ? { status: `in.(${input.statuses.join(',')})` } : {}),
    ...(input.action ? { action: `eq.${input.action}` } : {}),
    ...(pattern ? { action: pattern } : {}),
    ...(input.pattern === 'register_or_baseline' ? { or: '(action.like.*_register,action.like.chrome_baseline_*)' } : {}),
    ...(input.since && input.until ? { and: `(${timeField}.gte.${input.since},${timeField}.lte.${input.until})` }
      : input.since ? { [timeField]: `gte.${input.since}` }
        : input.until ? { [timeField]: `lte.${input.until}` } : {}),
    order: `started_at.${input.ascending ? 'asc' : 'desc'}`,
    limit: Math.min(input.limit, MAX_ANALYTICS_LIMIT),
  });
}

export async function updateActionLog(logId: string, patch: JsonObject) {
  const rows = await rest<JsonObject[]>('account_action_logs', { id: `eq.${logId}`, select: 'id,status,result,error,completed_at' }, {
    method: 'PATCH', body: patch, prefer: 'return=representation',
  });
  return rows.at(ZERO) ?? null;
}

export async function listBanSignalLogs(since: string, limit: number, accountIds?: string[]) {
  if (accountIds && !accountIds.length) return [];
  return rest<JsonObject[]>('account_action_logs', {
    select: 'id,account_id,action,platform,params,result,started_at,completed_at,claimed_at',
    'result->ban_signal->>healthy': 'eq.false',
    'result->ban_signal->>signal': 'not.in.(unknown,unknown_error)',
    ...(accountIds?.length ? { account_id: `in.(${accountIds.join(',')})` } : {}),
    claimed_at: `gte.${since}`,
    order: 'claimed_at.desc',
    limit: Math.min(limit, MAX_ANALYTICS_LIMIT),
  });
}

export async function queryHealthSnapshots(input: HealthSnapshotQuery) {
  if (input.accountIds && !input.accountIds.length) return [];
  return rest<JsonObject[]>('account_health_snapshots', {
    select: 'account_id,signal,shadowbanned,is_suspended,karma,checked_at',
    ...(input.accountIds?.length ? { account_id: `in.(${input.accountIds.join(',')})` } : {}),
    ...(input.accountId ? { account_id: `eq.${input.accountId}` } : {}),
    ...(input.since ? { checked_at: `gte.${input.since}` } : {}),
    order: `checked_at.${input.ascending ? 'asc' : 'desc'}`,
    limit: Math.min(input.limit, MAX_ANALYTICS_LIMIT),
  });
}

export async function listActivityProfiles(platform: ActivityPlatform, accountId?: string) {
  return rest<JsonObject[]>(ACTIVITY_PROFILE_TABLE[platform], {
    select: '*',
    ...(accountId ? { account_id: `eq.${accountId}` } : {}),
    order: 'created_at.desc',
    limit: MAX_ACCOUNT_LIMIT,
  });
}

export async function upsertActivityProfile(platform: ActivityPlatform, profile: JsonObject) {
  const rows = await rest<JsonObject[]>(ACTIVITY_PROFILE_TABLE[platform], { on_conflict: 'account_id', select: '*' }, {
    method: 'POST', body: profile, prefer: 'resolution=merge-duplicates,return=representation',
  });
  return rows.at(ZERO) ?? null;
}

export async function deleteActivityProfile(platform: ActivityPlatform, accountId: string) {
  await rest(ACTIVITY_PROFILE_TABLE[platform], { account_id: `eq.${accountId}` }, {
    method: 'DELETE', prefer: 'return=minimal',
  });
}

export async function listAccountAutomations(accountId?: string, limit = MAX_ACCOUNT_LIMIT) {
  return rest<JsonObject[]>('account_automations', {
    select: '*',
    ...(accountId ? { account_id: `eq.${accountId}` } : {}),
    order: 'created_at.desc',
    limit: Math.min(limit, MAX_ACCOUNT_LIMIT),
  });
}

export async function createAccountAutomation(row: JsonObject) {
  const rows = await rest<JsonObject[]>('account_automations', { select: '*' }, {
    method: 'POST', body: row, prefer: 'return=representation',
  });
  return rows.at(ZERO) ?? null;
}

export async function updateAccountAutomation(accountId: string, automationId: string, patch: JsonObject) {
  const rows = await rest<JsonObject[]>('account_automations', {
    account_id: `eq.${accountId}`, id: `eq.${automationId}`, select: '*',
  }, {
    method: 'PATCH', body: patch, prefer: 'return=representation',
  });
  return rows.at(ZERO) ?? null;
}

export async function deleteAccountAutomation(accountId: string, automationId: string) {
  await rest('account_automations', { account_id: `eq.${accountId}`, id: `eq.${automationId}` }, {
    method: 'DELETE', prefer: 'return=minimal',
  });
}

export async function enqueueActions(rows: JsonObject[]) {
  return rest<Array<{ id: string }>>('account_action_logs', { select: 'id' }, {
    method: 'POST', body: rows, prefer: 'return=representation',
  });
}

export async function getJob(jobId: string) {
  const rows = await rest<JsonObject[]>('account_action_logs', {
    select: 'id,account_id,action,platform,status,result,error,started_at,completed_at,claimed_by,params,scheduled_at',
    id: `eq.${jobId}`,
    limit: ONE,
  });
  return rows.at(ZERO) ?? null;
}

export async function getJobs(jobIds: string[]) {
  if (!jobIds.length) return [];
  return rest<JsonObject[]>('account_action_logs', {
    select: 'id,account_id,action,platform,status,result,error,started_at,completed_at,claimed_by,params,scheduled_at',
    id: `in.(${jobIds.join(',')})`,
    limit: MAX_JOB_LIMIT,
  });
}

export async function listPangramJobs(paperSlug: string) {
  return rest<JsonObject[]>('account_action_logs', {
    select: 'id,action,platform,status,result,error,started_at,completed_at,params,scheduled_at',
    action: 'eq.pangram_analyze_text',
    'params->>paper_slug': `eq.${paperSlug}`,
    order: 'scheduled_at.desc',
    limit: MAX_JOB_LIMIT,
  });
}

export async function recordActionResult(input: {
  accountId: string;
  action: string;
  params: JsonObject;
  success: boolean;
  result: unknown;
  error: string | null;
  startedAt: string;
  completedAt: string;
  accountStatus?: string;
  synced?: boolean;
}) {
  await rest('account_action_logs', {}, {
    method: 'POST',
    body: {
      account_id: input.accountId,
      action: input.action,
      params: input.params,
      status: input.success ? 'completed' : 'failed',
      result: input.success ? input.result : null,
      error: input.success ? null : input.error,
      started_at: input.startedAt,
      completed_at: input.completedAt,
    },
    prefer: 'return=minimal',
  });
  if (input.synced || input.accountStatus) {
    await rest('social_accounts', { id: `eq.${input.accountId}` }, {
      method: 'PATCH',
      body: {
        ...(input.synced ? { last_synced_at: input.completedAt, status: 'active' } : {}),
        ...(input.accountStatus ? { status: input.accountStatus } : {}),
      },
      prefer: 'return=minimal',
    });
  }
}

export async function getRuntimeSettings(keys: string[]) {
  if (!keys.length) return [];
  return rest<JsonObject[]>('system_settings', {
    select: 'key,value,updated_at',
    key: `in.(${keys.join(',')})`,
    limit: keys.length,
  });
}

export async function setRuntimeSetting(key: string, value: JsonObject) {
  await rest('system_settings', { on_conflict: 'key' }, {
    method: 'POST',
    body: { key, value, updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

export async function workerStatus() {
  const fiveMinutesAgo = new Date(Date.now() - FIVE_MINUTES_MS).toISOString();
  const [settings, running] = await Promise.all([
    rest<JsonObject[]>('system_settings', { select: 'value', key: 'eq.workers_enabled', limit: ONE }),
    rest<JsonObject[]>('account_action_logs', {
      select: 'id,claimed_by,claimed_at', status: 'eq.running', claimed_at: `gte.${fiveMinutesAgo}`,
    }),
  ]);
  const enabled = (settings.at(ZERO)?.value as JsonObject | undefined)?.enabled !== false;
  const workers = new Set(running.map((row) => row.claimed_by).filter((value): value is string => typeof value === 'string' && value.length > ZERO));
  return {
    enabled,
    worker_count: workers.size,
    active_jobs: running.length,
    active_job_ids: running.map((row) => row.id),
    poll_interval: POLL_INTERVAL_SECONDS,
    instance_id: 'aggregate',
  };
}

export async function setWorkersEnabled(enabled: boolean) {
  await rest('system_settings', { on_conflict: 'key' }, {
    method: 'POST',
    body: { key: 'workers_enabled', value: { enabled }, updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  return { ok: true, enabled };
}

export async function deploymentVersion() {
  const rows = await rest<JsonObject[]>('system_settings', {
    select: 'key,value,updated_at', key: 'eq.weles_deployment_version', limit: ONE,
  });
  return rows.at(ZERO) ?? null;
}

export async function createLifecycle(input: { run: JsonObject; actions: JsonObject[] }) {
  const runs = await rest<Array<{ id: string; status: string }>>('employee_lifecycle_runs', { select: 'id,status' }, {
    method: 'POST', body: input.run, prefer: 'return=representation',
  });
  const run = runs.at(ZERO);
  if (!run) throw new Error('Weles lifecycle run was not created');
  if (input.actions.length) {
    await rest('employee_lifecycle_actions', {}, {
      method: 'POST',
      body: input.actions.map((action) => ({ ...action, run_id: run.id })),
      prefer: 'return=minimal',
    });
  }
  return run;
}

export async function getLifecycleRun(runId: string) {
  const rows = await rest<JsonObject[]>('employee_lifecycle_runs', {
    select: '*,employee_lifecycle_actions(*)', id: `eq.${runId}`, limit: ONE,
  });
  return rows.at(ZERO) ?? null;
}

export async function cancelLifecycleRun(runId: string) {
  const rows = await rest<Array<{ id: string; status: string }>>('employee_lifecycle_runs', {
    id: `eq.${runId}`, status: 'in.(queued,running)', select: 'id,status',
  }, {
    method: 'PATCH', body: { status: 'cancel_requested' }, prefer: 'return=representation',
  });
  const run = rows.at(ZERO);
  if (!run) return null;
  await rest('employee_lifecycle_events', {}, {
    method: 'POST', body: { run_id: runId, event_type: 'cancel_requested', payload: {} }, prefer: 'return=minimal',
  });
  return run;
}

export async function lifecycleEvents(runId: string) {
  return rest<JsonObject[]>('employee_lifecycle_events', {
    select: '*', run_id: `eq.${runId}`, order: 'created_at.asc', limit: MAX_EVENT_LIMIT,
  });
}

export async function listDueCampaignItems(campaignId: string, now: string) {
  return rest<JsonObject[]>('campaign_items', {
    select: 'id,campaign_id,target,params_override,scheduled_for',
    campaign_id: `eq.${campaignId}`, status: 'eq.pending', scheduled_for: `lte.${now}`,
    order: 'scheduled_for.asc', limit: DUE_ITEM_LIMIT,
  });
}

export async function recentAccountActions(accountIds: string[], since: string) {
  if (!accountIds.length) return [];
  return rest<JsonObject[]>('account_action_logs', {
    select: 'account_id,started_at,action', account_id: `in.(${accountIds.join(',')})`,
    started_at: `gte.${since}`, order: 'started_at.desc', limit: RECENT_ACTION_LIMIT,
  });
}

export async function updateCampaignItem(itemId: string, patch: JsonObject) {
  await rest('campaign_items', { id: `eq.${itemId}` }, {
    method: 'PATCH', body: patch, prefer: 'return=minimal',
  });
}

export async function hasRecentAction(accountId: string, action: string, since: string) {
  const rows = await rest<Array<{ id: string }>>('account_action_logs', {
    select: 'id', account_id: `eq.${accountId}`, action: `eq.${action}`,
    started_at: `gte.${since}`, limit: ONE,
  });
  return rows.length > ZERO;
}
