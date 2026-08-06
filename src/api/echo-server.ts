import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { acquireSecret, buildSecretAcquisitionPlan, type AcquireSecretRequest } from '../secrets/acquire.js';
import {
  cancelLifecycleRun, createAccountAutomation, createLifecycle, deleteAccount, deleteAccountAutomation,
  deleteActivityProfile, deploymentVersion, enqueueActions, getAccount, getAccountByPlatformUsername, getJob, getJobs, getLifecycleRun,
  getRuntimeSettings, hasRecentAction, lifecycleEvents, listAccountActionLogs, listAccountAutomations, listAccounts,
  listActivityProfiles, listBanSignalLogs, listDueCampaignItems, listPangramJobs, queryAccounts,
  queryActionLogs, queryHealthSnapshots, recentAccountActions, recordActionResult, setRuntimeSetting,
  setWorkersEnabled, updateAccount, updateAccountAutomation, updateActionLog, updateCampaignItem, upsertAccount,
  upsertActivityProfile, workerStatus, type AccountListOptions, type ActionLogPattern,
  type ActionLogTimeField, type ActivityPlatform, type JsonObject,
} from './echo-store.js';

const ZERO = Number('0');
const ONE = Number('1');
const MIN_TOKEN_BYTES = Number('32');
const MAX_BODY_BYTES = Number('1048576');
const MAX_STRING = Number('20000');
const MAX_ROWS = Number('100');
const HOUR_MS = Number('3600000');
const DAY_MS = Number('86400000');
const DEFAULT_PORT = Number('8794');
const SERVER_HOST = '127.0.0.1';
const ALLOWED_ACCOUNT_STATUS: Record<string, true> = {
  active: true, banned: true, suspended: true, locked: true, login_required: true,
  flagged: true, shadowbanned: true, auto_disabled_login_failures: true,
};
const ACCOUNTLESS_ACTION: Record<string, true> = {
  generic_browser_task: true,
  pangram_analyze_text: true,
  slack_post_message: true,
  slack_provision_user_token: true,
};
const DANGEROUS_PARAM_KEYS: Record<string, true> = {
  env: true, environment: true, script: true, script_path: true, command: true,
  executable: true, cwd: true, process_env: true,
};
const SENSITIVE_OUTPUT_KEY = /(?:api[_-]?key|secret|token|password|authorization|cookie|credential|captcha[_-]?key)/i;
const ACTIVITY_PLATFORMS: Record<string, ActivityPlatform> = {
  reddit: 'reddit', instagram: 'instagram', tiktok: 'tiktok',
};
const ACTION_LOG_PATTERNS: Record<string, ActionLogPattern> = {
  topup: 'topup', register_or_baseline: 'register_or_baseline', exclude_health: 'exclude_health',
};
const ACTION_LOG_TIME_FIELDS: Record<string, ActionLogTimeField> = {
  started_at: 'started_at', completed_at: 'completed_at', claimed_at: 'claimed_at',
};
const ACCOUNT_MUTATION_FIELDS: Record<string, true> = {
  platform: true, username: true, display_name: true, avatar_url: true, profile_url: true,
  access_token: true, refresh_token: true, token_expires_at: true, followers_count: true,
  following_count: true, posts_count: true, metadata: true, created_by: true, is_active: true,
  status: true, lifecycle_phase: true, lifecycle_phase_updated_at: true, paused_until: true,
  last_synced_at: true,
};
const PROFILE_COMMON_FIELDS: Record<string, true> = {
  persona_type: true, active_windows: true, timezone_offset: true, min_session_gap_minutes: true,
  sessions_per_day_min: true, sessions_per_day_max: true, is_enabled: true,
};
const PROFILE_FIELDS: Record<ActivityPlatform, Record<string, true>> = {
  reddit: {
    ...PROFILE_COMMON_FIELDS, engagement_rate_min: true, engagement_rate_max: true,
    comment_enabled: true, comment_probability: true, auto_post_comments: true,
    auto_post_daily_limit: true, follow_probability: true, subreddits: true, browse_sources: true,
  },
  instagram: {
    ...PROFILE_COMMON_FIELDS, like_rate_min: true, like_rate_max: true,
    profile_visit_rate: true, follow_rate: true,
  },
  tiktok: {
    ...PROFILE_COMMON_FIELDS, like_rate_min: true, like_rate_max: true,
    profile_visit_rate: true, follow_rate: true,
  },
};
const AUTOMATION_SCHEDULES: Record<string, true> = {
  every_30m: true, hourly: true, every_6h: true, every_12h: true, daily: true, weekly: true,
};
const RUNTIME_SETTING_KEYS: Record<string, true> = {
  workers_enabled: true,
  social_routines_enabled: true,
  platform_routine_paused: true,
  lifecycle_calibration: true,
  lifecycle_experiment: true,
  lifecycle_experiment_meta: true,
  burned_proxies: true,
};

type Handler = (body: JsonObject) => Promise<unknown>;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function actionCatalog(): Record<string, true> {
  const values = requiredEnv('WELES_ACTION_ALLOWLIST').split(',').map((value) => value.trim()).filter(Boolean);
  if (!values.length || values.some((value) => !/^[a-z][a-z\d_]*$/.test(value))) throw new Error('WELES_ACTION_ALLOWLIST must contain exact action names');
  return Object.fromEntries(values.map((value) => [value, true])) as Record<string, true>;
}

function hashToken(value: string) { return createHash('sha256').update(value).digest(); }

function authorized(request: IncomingMessage, expectedHash: Buffer): boolean {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  return timingSafeEqual(hashToken(header.slice('Bearer '.length)), expectedHash);
}

function text(value: unknown, name: string, max = MAX_STRING): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const clean = value.trim();
  if (!clean || clean.length > max) throw new Error(`${name} is invalid`);
  return clean;
}

function identifier(value: unknown, name: string): string {
  const clean = text(value, name, Number('200'));
  if (!/^[A-Za-z\d_-]+$/.test(clean)) throw new Error(`${name} is invalid`);
  return clean;
}

function timestamp(value: unknown, name: string): string {
  const clean = text(value, name, Number('64'));
  if (!Number.isFinite(Date.parse(clean))) throw new Error(`${name} must be an ISO timestamp`);
  return clean;
}

function optionalText(value: unknown, name: string, max = MAX_STRING): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return text(value, name, max);
}

function finiteNumber(value: unknown, name: string, minimum = ZERO, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be a finite number`);
  return value;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function stringArray(value: unknown, name: string, max = MAX_ROWS): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array`);
  return value.map((entry, index) => identifier(entry, `${name}[${index}]`));
}

function safeParams(value: unknown, name = 'params', depth = ZERO): JsonObject {
  if (depth > Number('8')) throw new Error(`${name} is too deeply nested`);
  const source = object(value ?? {}, name);
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(source)) {
    if (!/^[a-zA-Z]\w*$/.test(key) || DANGEROUS_PARAM_KEYS[key.toLowerCase()]) throw new Error(`${name}.${key} is not permitted`);
    if (typeof child === 'string') output[key] = text(child, `${name}.${key}`);
    else if (typeof child === 'number') output[key] = finiteNumber(child, `${name}.${key}`, -Number.MAX_SAFE_INTEGER);
    else if (typeof child === 'boolean' || child === null) output[key] = child;
    else if (Array.isArray(child)) {
      if (child.length > MAX_ROWS) throw new Error(`${name}.${key} is too large`);
      output[key] = child.map((entry, index) => {
        if (typeof entry === 'string') return text(entry, `${name}.${key}[${index}]`);
        if (typeof entry === 'number') return finiteNumber(entry, `${name}.${key}[${index}]`, -Number.MAX_SAFE_INTEGER);
        if (typeof entry === 'boolean' || entry === null) return entry;
        return safeParams(entry, `${name}.${key}[${index}]`, depth + ONE);
      });
    } else output[key] = safeParams(child, `${name}.${key}`, depth + ONE);
  }
  return output;
}

function sanitizeOutput(value: unknown, key = '', depth = ZERO): unknown {
  if (SENSITIVE_OUTPUT_KEY.test(key)) return '[REDACTED]';
  if (depth > Number('12') || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[AUTH]')
      .replace(/\b(?:sk|tok|ghp|gho|ghu|ghs)_[A-Za-z\d_-]+\b/gi, '[SECRET]');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeOutput(entry, '', depth + ONE));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as JsonObject).map(([childKey, child]) => [
      childKey,
      sanitizeOutput(child, childKey, depth + ONE),
    ]));
  }
  return '[REDACTED]';
}

function action(value: unknown, catalog: Record<string, true>) {
  const name = text(value, 'action', Number('120'));
  if (!catalog[name]) throw new Error(`action is not in the Weles operation catalog: ${name}`);
  return name;
}

function platform(value: unknown) {
  const name = text(value, 'platform', Number('40'));
  if (!/^[a-z][a-z\d_]*$/.test(name)) throw new Error('platform is invalid');
  return name;
}

function activityPlatform(value: unknown): ActivityPlatform {
  const name = platform(value);
  const allowed = ACTIVITY_PLATFORMS[name];
  if (!allowed) throw new Error('platform does not have a Weles activity profile');
  return allowed;
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  return value === undefined ? fallback : finiteNumber(value, 'limit', ONE, maximum);
}

function optionalIdentifiers(value: unknown, name: string, maximum: number): string[] | undefined {
  if (value === undefined) return undefined;
  return stringArray(value, name, maximum);
}

function allowedFields(value: unknown, name: string, catalog: Record<string, true>): JsonObject {
  const clean = safeParams(value, name);
  for (const key of Object.keys(clean)) {
    if (!catalog[key]) throw new Error(`${name}.${key} is not permitted`);
  }
  return clean;
}

function accountMutation(value: unknown): JsonObject {
  const clean = allowedFields(value, 'account', ACCOUNT_MUTATION_FIELDS);
  if (clean.platform !== undefined) clean.platform = platform(clean.platform);
  if (clean.username !== undefined) clean.username = text(clean.username, 'account.username', Number('320'));
  if (clean.metadata !== undefined) {
    const metadata = object(clean.metadata, 'account.metadata');
    for (const field of ['password', 'skarbiec_credential_id', 'skarbiec_tenant_id']) {
      if (Object.prototype.hasOwnProperty.call(metadata, field)) {
        throw new Error(`account.metadata.${field} is managed by the credential lifecycle`);
      }
    }
    clean.metadata = metadata;
  }
  if (clean.status !== undefined) {
    const status = text(clean.status, 'account.status', Number('40'));
    if (!ALLOWED_ACCOUNT_STATUS[status]) throw new Error('account.status is not permitted');
    clean.status = status;
  }
  for (const field of ['token_expires_at', 'paused_until', 'lifecycle_phase_updated_at', 'last_synced_at']) {
    if (clean[field] !== undefined && clean[field] !== null) clean[field] = timestamp(clean[field], `account.${field}`);
  }
  return clean;
}

function accountListQuery(body: JsonObject): AccountListOptions {
  const platformName = optionalText(body.platform, 'platform', Number('40'));
  const statuses = optionalIdentifiers(body.statuses, 'statuses', Number('20'));
  const accountIds = optionalIdentifiers(body.account_ids, 'account_ids', Number('500'));
  if (statuses?.some((status) => !ALLOWED_ACCOUNT_STATUS[status])) throw new Error('statuses contains an unsupported account status');
  return {
    ...(platformName ? { platform: platform(platformName) } : {}),
    ...(accountIds !== undefined ? { ids: accountIds } : {}),
    ...(statuses ? { statuses } : {}),
    activeOnly: body.active_only === undefined ? false : bool(body.active_only, 'active_only'),
    ascending: body.ascending === undefined ? false : bool(body.ascending, 'ascending'),
    limit: boundedLimit(body.limit, Number('500'), Number('5000')),
  };
}

function actionLogQuery(body: JsonObject) {
  const patternName = optionalText(body.pattern, 'pattern', Number('40'));
  const pattern = patternName ? ACTION_LOG_PATTERNS[patternName] : undefined;
  if (patternName && !pattern) throw new Error('pattern is not supported');
  const fieldName = optionalText(body.since_field, 'since_field', Number('40'));
  const sinceField = fieldName ? ACTION_LOG_TIME_FIELDS[fieldName] : undefined;
  if (fieldName && !sinceField) throw new Error('since_field is not supported');
  const statuses = optionalIdentifiers(body.statuses, 'statuses', Number('20'));
  const accountId = optionalText(body.account_id, 'account_id', Number('200'));
  const accountIds = optionalIdentifiers(body.account_ids, 'account_ids', Number('500'));
  return {
    ...(accountIds !== undefined ? { accountIds } : {}),
    ...(accountId ? { accountId: identifier(accountId, 'account_id') } : {}),
    ...(statuses ? { statuses } : {}),
    ...(body.action === undefined ? {} : { action: identifier(body.action, 'action') }),
    ...(pattern ? { pattern } : {}),
    ...(body.since === undefined ? {} : { since: timestamp(body.since, 'since') }),
    ...(body.until === undefined ? {} : { until: timestamp(body.until, 'until') }),
    ...(sinceField ? { sinceField } : {}),
    ascending: body.ascending === undefined ? false : bool(body.ascending, 'ascending'),
    limit: boundedLimit(body.limit, Number('50'), Number('5000')),
  };
}

function activityProfileMutation(platformName: ActivityPlatform, body: JsonObject): JsonObject {
  return allowedFields(body, 'profile', PROFILE_FIELDS[platformName]);
}

function automationSchedule(value: unknown): string {
  const schedule = text(value, 'schedule', Number('40'));
  if (!AUTOMATION_SCHEDULES[schedule]) throw new Error('schedule is not supported');
  return schedule;
}

function queuedAction(body: JsonObject, catalog: Record<string, true>) {
  const accountId = body.account_id === null || body.account_id === undefined ? null : identifier(body.account_id, 'account_id');
  const actionName = action(body.action, catalog);
  if (!accountId && !actionName.endsWith('_register') && !ACCOUNTLESS_ACTION[actionName]) {
    throw new Error(`account_id is required for ${actionName}`);
  }
  return {
    account_id: accountId, action: actionName, platform: platform(body.platform), status: 'queued',
    scheduled_at: body.scheduled_at === undefined ? new Date().toISOString() : timestamp(body.scheduled_at, 'scheduled_at'),
    params: safeParams(body.params),
    ...(body.priority === undefined ? {} : { priority: finiteNumber(body.priority, 'priority', ZERO, Number('100')) }),
  };
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  if (request.headers['content-type']?.split(';').at(ZERO)?.trim() !== 'application/json') throw new Error('Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let size = ZERO;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, 'body');
}

function send(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function handlers(catalog: Record<string, true>): Record<string, Handler> {
  return {
    '/v1/echo/action-logs/list': async (body) => ({
      logs: sanitizeOutput(await listAccountActionLogs(identifier(body.account_id, 'account_id'))) as JsonObject[],
    }),
    '/v1/echo/action-logs/query': async (body) => ({
      logs: sanitizeOutput(await queryActionLogs(actionLogQuery(body))) as JsonObject[],
    }),
    '/v1/echo/action-logs/update': async (body) => {
      const patch = allowedFields(body.patch, 'patch', {
        result: true, error: true, status: true, completed_at: true,
      });
      if (patch.result !== undefined) patch.result = safeParams({ value: patch.result }, 'patch.result').value;
      if (patch.error !== undefined && patch.error !== null) patch.error = text(patch.error, 'patch.error');
      if (patch.completed_at !== undefined && patch.completed_at !== null) {
        patch.completed_at = timestamp(patch.completed_at, 'patch.completed_at');
      }
      if (patch.status !== undefined) {
        const status = identifier(patch.status, 'patch.status');
        if (!['completed', 'failed', 'rejected', 'approved'].includes(status)) throw new Error('patch.status is not permitted');
        patch.status = status;
      }
      return { log: sanitizeOutput(await updateActionLog(identifier(body.log_id, 'log_id'), patch)) };
    },
    '/v1/echo/ban-signals/list': async (body) => ({
      logs: sanitizeOutput(await listBanSignalLogs(
        timestamp(body.since, 'since'),
        boundedLimit(body.limit, Number('500'), Number('5000')),
        optionalIdentifiers(body.account_ids, 'account_ids', Number('500')),
      )) as JsonObject[],
    }),
    '/v1/echo/health-snapshots/list': async (body) => {
      const accountIds = optionalIdentifiers(body.account_ids, 'account_ids', Number('500'));
      return {
        snapshots: sanitizeOutput(await queryHealthSnapshots({
          ...(accountIds !== undefined ? { accountIds } : {}),
          ...(body.account_id === undefined ? {} : { accountId: identifier(body.account_id, 'account_id') }),
          ...(body.since === undefined ? {} : { since: timestamp(body.since, 'since') }),
          ascending: body.ascending === undefined ? false : bool(body.ascending, 'ascending'),
          limit: boundedLimit(body.limit, Number('50'), Number('5000')),
        })) as JsonObject[],
      };
    },
    '/v1/echo/accounts/get': async (body) => ({
      account: sanitizeOutput(await getAccount(identifier(body.account_id, 'account_id'))),
    }),
    '/v1/echo/accounts/query': async (body) => ({
      accounts: sanitizeOutput(await queryAccounts(accountListQuery(body))) as JsonObject[],
    }),
    '/v1/echo/accounts/list': async (body) => ({
      accounts: sanitizeOutput(await listAccounts(platform(body.platform))) as JsonObject[],
    }),
    '/v1/echo/accounts/upsert': async (body) => {
      const account = accountMutation(body.account);
      if (account.platform === undefined || account.username === undefined) throw new Error('account platform and username are required');
      const existing = await getAccountByPlatformUsername(
        platform(account.platform),
        text(account.username, 'account.username', Number('320')),
      );
      if (existing?.metadata && typeof existing.metadata === 'object') {
        account.metadata = {
          ...existing.metadata as JsonObject,
          ...(account.metadata && typeof account.metadata === 'object'
            ? account.metadata as JsonObject
            : {}),
        };
      }
      return { account: sanitizeOutput(await upsertAccount({ ...account, updated_at: new Date().toISOString() })) };
    },
    '/v1/echo/accounts/update': async (body) => {
      const accountId = identifier(body.account_id, 'account_id');
      const patch = accountMutation(body.patch);
      if (patch.metadata !== undefined) {
        const existing = await getAccount(accountId);
        patch.metadata = {
          ...(existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata as JsonObject : {}),
          ...object(patch.metadata, 'account.metadata'),
        };
      }
      return {
        account: sanitizeOutput(await updateAccount(accountId, { ...patch, updated_at: new Date().toISOString() })),
      };
    },
    '/v1/echo/accounts/delete': async (body) => {
      await deleteAccount(identifier(body.account_id, 'account_id'));
      return { ok: true };
    },
    '/v1/echo/experiments/canary/pick': async (body) => {
      const accounts = await queryAccounts({
        platform: platform(body.platform), activeOnly: true, ascending: false, limit: Number('200'),
      });
      const now = Date.now();
      const eligible = accounts.find((account) => {
        const metadata = account.metadata && typeof account.metadata === 'object' ? account.metadata as JsonObject : {};
        if (metadata.experiment) return false;
        if (typeof account.paused_until === 'string' && Date.parse(account.paused_until) > now) return false;
        const mintedAt = typeof metadata.cookies_minted_at === 'string' ? Date.parse(metadata.cookies_minted_at) : Number.NaN;
        const staleAt = typeof metadata.cookies_stale_at === 'string' ? Date.parse(metadata.cookies_stale_at) : Number.NaN;
        if (!Number.isFinite(mintedAt)) return false;
        return !Number.isFinite(staleAt) || staleAt <= mintedAt;
      });
      return { account_id: typeof eligible?.id === 'string' ? eligible.id : null };
    },
    '/v1/echo/experiments/canary/untag': async (body) => {
      const accountId = identifier(body.account_id, 'account_id');
      const account = await getAccount(accountId);
      if (!account) return { ok: true };
      const metadata = account.metadata && typeof account.metadata === 'object'
        ? { ...(account.metadata as JsonObject) } : {};
      if (metadata.experiment) {
        const history = Array.isArray(metadata.experiment_history) ? metadata.experiment_history : [];
        history.push(metadata.experiment);
        metadata.experiment_history = history;
        delete metadata.experiment;
        await updateAccount(accountId, { metadata, updated_at: new Date().toISOString() });
      }
      return { ok: true };
    },
    '/v1/echo/activity-profiles/list': async (body) => {
      const profilePlatform = activityPlatform(body.platform);
      const accountId = optionalText(body.account_id, 'account_id', Number('200'));
      const profiles = await listActivityProfiles(profilePlatform, accountId ? identifier(accountId, 'account_id') : undefined);
      const accountIds = profiles.map((profile) => profile.account_id).filter((value): value is string => typeof value === 'string');
      const accounts = accountIds.length ? await queryAccounts({
        ids: accountIds, limit: Math.min(accountIds.length, Number('500')), ascending: false,
      }) : [];
      const accountById = new Map(accounts.map((account) => [account.id, account]));
      return {
        profiles: sanitizeOutput(profiles.map((profile) => ({
          ...profile,
          social_accounts: accountById.get(profile.account_id) ?? null,
        }))) as JsonObject[],
      };
    },
    '/v1/echo/activity-profiles/upsert': async (body) => {
      const profilePlatform = activityPlatform(body.platform);
      const profile = {
        account_id: identifier(body.account_id, 'account_id'),
        ...activityProfileMutation(profilePlatform, object(body.profile, 'profile')),
      };
      return { profile: sanitizeOutput(await upsertActivityProfile(profilePlatform, profile)) };
    },
    '/v1/echo/activity-profiles/delete': async (body) => {
      await deleteActivityProfile(activityPlatform(body.platform), identifier(body.account_id, 'account_id'));
      return { ok: true };
    },
    '/v1/echo/automations/list': async (body) => ({
      automations: sanitizeOutput(await listAccountAutomations(
        body.account_id === undefined ? undefined : identifier(body.account_id, 'account_id'),
        boundedLimit(body.limit, Number('50'), Number('500')),
      )) as JsonObject[],
    }),
    '/v1/echo/automations/create': async (body) => {
      const accountId = identifier(body.account_id, 'account_id');
      if (!await getAccount(accountId)) throw new Error('account not found');
      return {
        automation: sanitizeOutput(await createAccountAutomation({
          account_id: accountId,
          action: action(body.action, catalog),
          action_params: safeParams(body.action_params),
          schedule: body.schedule === undefined ? 'daily' : automationSchedule(body.schedule),
          is_enabled: true,
          next_run_at: new Date().toISOString(),
        })),
      };
    },
    '/v1/echo/automations/update': async (body) => {
      const patch = allowedFields(body.patch, 'patch', {
        action: true, action_params: true, schedule: true, is_enabled: true, next_run_at: true,
      });
      if (patch.action !== undefined) patch.action = action(patch.action, catalog);
      if (patch.action_params !== undefined) patch.action_params = safeParams(patch.action_params, 'patch.action_params');
      if (patch.schedule !== undefined) patch.schedule = automationSchedule(patch.schedule);
      if (patch.is_enabled !== undefined) patch.is_enabled = bool(patch.is_enabled, 'patch.is_enabled');
      if (patch.next_run_at !== undefined) patch.next_run_at = timestamp(patch.next_run_at, 'patch.next_run_at');
      return {
        automation: sanitizeOutput(await updateAccountAutomation(
          identifier(body.account_id, 'account_id'),
          identifier(body.automation_id, 'automation_id'),
          { ...patch, updated_at: new Date().toISOString() },
        )),
      };
    },
    '/v1/echo/automations/delete': async (body) => {
      await deleteAccountAutomation(
        identifier(body.account_id, 'account_id'),
        identifier(body.automation_id, 'automation_id'),
      );
      return { ok: true };
    },
    '/v1/echo/reviews/list': async (body) => {
      const logs = await queryActionLogs({
        statuses: ['pending_review'], ascending: false,
        limit: boundedLimit(body.limit, Number('500'), Number('500')),
      });
      const accountIds = logs.map((log) => log.account_id).filter((value): value is string => typeof value === 'string');
      const accounts = accountIds.length ? await queryAccounts({
        ids: [...new Set(accountIds)], limit: Math.min(accountIds.length, Number('500')), ascending: false,
      }) : [];
      const accountById = new Map(accounts.map((account) => [account.id, account]));
      return {
        reviews: sanitizeOutput(logs.map((log) => ({
          ...log,
          social_accounts: accountById.get(log.account_id) ?? null,
        }))) as JsonObject[],
      };
    },
    '/v1/echo/reviews/resolve': async (body) => {
      const logId = identifier(body.log_id, 'log_id');
      const decision = identifier(body.decision, 'decision');
      const row = await getJob(logId);
      if (!row || row.status !== 'pending_review') throw new Error('pending review not found');
      if (decision === 'reject') {
        await updateActionLog(logId, {
          status: 'rejected',
          error: optionalText(body.reason, 'reason') ?? 'rejected by operator',
          completed_at: new Date().toISOString(),
        });
        return { ok: true, decision };
      }
      if (decision !== 'approve') throw new Error('decision must be approve or reject');
      const params = body.params === undefined ? safeParams(row.params) : safeParams(body.params);
      const queued = queuedAction({
        account_id: row.account_id, action: row.action, platform: row.platform,
        scheduled_at: new Date().toISOString(), params,
      }, catalog);
      const inserted = await enqueueActions([queued]);
      const replacementId = inserted.at(ZERO)?.id;
      const priorResult = row.result && typeof row.result === 'object' && !Array.isArray(row.result)
        ? row.result as JsonObject
        : {};
      await updateActionLog(logId, {
        status: 'approved',
        completed_at: new Date().toISOString(),
        result: { ...priorResult, approved_job_id: replacementId ?? null },
      });
      return { ok: true, decision, job_id: replacementId };
    },
    '/v1/echo/jobs/enqueue': async (body) => {
      const rows = await enqueueActions([queuedAction(body, catalog)]);
      return { job_id: rows.at(ZERO)?.id };
    },
    '/v1/echo/jobs/enqueue-batch': async (body) => {
      if (!Array.isArray(body.jobs) || !body.jobs.length || body.jobs.length > MAX_ROWS) throw new Error('jobs is invalid');
      const jobs = body.jobs.map((entry, index) => queuedAction(object(entry, `jobs[${index}]`), catalog));
      return { job_ids: (await enqueueActions(jobs)).map((row) => row.id) };
    },
    '/v1/echo/jobs/get': async (body) => {
      const job = await getJob(identifier(body.job_id, 'job_id'));
      const accountId = job && typeof job.account_id === 'string' ? job.account_id
        : job && job.result && typeof job.result === 'object' && typeof (job.result as JsonObject).account_id === 'string'
          ? (job.result as JsonObject).account_id as string : null;
      return {
        job: sanitizeOutput(job),
        account: sanitizeOutput(accountId ? await getAccount(accountId) : null),
      };
    },
    '/v1/echo/jobs/get-many': async (body) => ({
      jobs: sanitizeOutput(await getJobs(stringArray(body.job_ids, 'job_ids'))) as JsonObject[],
    }),
    '/v1/echo/pangram/list': async (body) => ({
      jobs: sanitizeOutput(await listPangramJobs(text(body.paper_slug, 'paper_slug', Number('240')))) as JsonObject[],
    }),
    '/v1/echo/actions/record-result': async (body) => {
      const status = optionalText(body.account_status, 'account_status', Number('40'));
      if (status && !ALLOWED_ACCOUNT_STATUS[status]) throw new Error('account_status is not permitted');
      await recordActionResult({
        accountId: identifier(body.account_id, 'account_id'), action: text(body.action, 'action', Number('120')),
        params: safeParams(body.params), success: bool(body.success, 'success'),
        result: safeParams({ value: body.result ?? null }, 'result').value,
        error: optionalText(body.error, 'error') ?? null,
        startedAt: timestamp(body.started_at, 'started_at'),
        completedAt: timestamp(body.completed_at, 'completed_at'),
        ...(status ? { accountStatus: status } : {}), synced: body.synced === true,
      });
      return { ok: true };
    },
    '/v1/echo/runtime-settings/get': async (body) => {
      const keys = stringArray(body.keys, 'keys', Number('10'));
      if (!keys.length || keys.some((key) => !RUNTIME_SETTING_KEYS[key])) {
        throw new Error('keys contains an unsupported runtime setting');
      }
      return { settings: sanitizeOutput(await getRuntimeSettings(keys)) as JsonObject[] };
    },
    '/v1/echo/runtime-settings/set': async (body) => {
      const key = identifier(body.key, 'key');
      if (!RUNTIME_SETTING_KEYS[key]) throw new Error('key is not a supported runtime setting');
      await setRuntimeSetting(key, safeParams(body.value, 'value'));
      return { ok: true };
    },
    '/v1/echo/workers/status': async () => workerStatus(),
    '/v1/echo/workers/set-enabled': async (body) => setWorkersEnabled(bool(body.enabled, 'enabled')),
    '/v1/echo/deployment-version': async () => ({ setting: await deploymentVersion() }),
    '/v1/echo/lifecycle/create': async (body) => {
      const run = object(body.run, 'run');
      const workflow = text(run.workflow, 'run.workflow', Number('20'));
      if (workflow !== 'onboarding' && workflow !== 'offboarding') throw new Error('run.workflow is invalid');
      const cleanRun = {
        workflow, status: text(run.status, 'run.status', Number('40')),
        person_email: text(run.person_email, 'run.person_email', Number('320')),
        person_name: optionalText(run.person_name, 'run.person_name', Number('320')) ?? '',
        github_user: optionalText(run.github_user, 'run.github_user', Number('200')) ?? '',
        role_slug: optionalText(run.role_slug, 'run.role_slug', Number('200')) ?? null,
        requested_platforms: safeParams({ value: run.requested_platforms }, 'run.requested_platforms').value,
        planned_platforms: safeParams({ value: run.planned_platforms }, 'run.planned_platforms').value,
        plan: safeParams({ value: run.plan }, 'run.plan').value,
        input: safeParams(run.input, 'run.input'),
        error: optionalText(run.error, 'run.error') ?? null,
      };
      if (!Array.isArray(body.actions) || body.actions.length > MAX_ROWS) throw new Error('actions is invalid');
      const actions = body.actions.map((entry, index) => {
        const row = object(entry, `actions[${index}]`);
        const executor = text(row.executor, `actions[${index}].executor`, Number('40'));
        if (executor !== 'direct_api' && executor !== 'weles_browser') throw new Error('action executor is invalid');
        const verificationStatus = text(row.verification_status, `actions[${index}].verification_status`, Number('40'));
        if (verificationStatus !== 'not_started' && verificationStatus !== 'failed') throw new Error('verification status is invalid');
        return {
          stage: text(row.stage, `actions[${index}].stage`, Number('120')),
          task_id: text(row.task_id, `actions[${index}].task_id`, Number('200')),
          platform: platform(row.platform),
          operation: text(row.operation, `actions[${index}].operation`, Number('200')),
          executor,
          status: text(row.status, `actions[${index}].status`, Number('40')),
          verification_status: verificationStatus,
          idempotency_key: text(row.idempotency_key, `actions[${index}].idempotency_key`, Number('500')),
          params: safeParams(row.params, `actions[${index}].params`),
          result: null,
          error: optionalText(row.error, `actions[${index}].error`) ?? null,
        };
      });
      return { run: await createLifecycle({ run: cleanRun, actions }) };
    },
    '/v1/echo/lifecycle/get': async (body) => ({
      run: sanitizeOutput(await getLifecycleRun(identifier(body.run_id, 'run_id'))),
    }),
    '/v1/echo/lifecycle/cancel': async (body) => ({ run: await cancelLifecycleRun(identifier(body.run_id, 'run_id')) }),
    '/v1/echo/lifecycle/events': async (body) => ({
      events: sanitizeOutput(await lifecycleEvents(identifier(body.run_id, 'run_id'))) as JsonObject[],
    }),
    '/v1/echo/secrets/acquire': async (body) => {
      if (body.version !== 'skarbiec.credential-operation.v3') {
        throw new Error('unsupported credential operation version');
      }
      const operation = optionalText(body.operation, 'operation', Number('20'));
      if (operation && operation !== 'acquire' && operation !== 'adopt' && operation !== 'rotate'
        && operation !== 'verify' && operation !== 'remove' && operation !== 'reset') {
        throw new Error('operation must be acquire, adopt, rotate, verify, remove, or reset');
      }
      const provider = optionalText(body.provider, 'provider', Number('128'));
      // The directory identity is the item's own contract, never a call argument:
      // when Skarbiec sends the canonical block it is the only accepted source of
      // the tenant, principal object id, and UPN.
      const directory = body.directory === undefined || body.directory === null
        ? null
        : object(body.directory, 'directory');
      if (directory && optionalText(directory.provider, 'directory.provider', Number('128')) !== provider) {
        throw new Error('directory.provider must equal the credential operation provider');
      }
      const request: AcquireSecretRequest = {
        operation: operation as AcquireSecretRequest['operation'],
        credentialId: optionalText(body.credential_id ?? body.credentialId, 'credential_id', Number('200')),
        provider,
        requestId: optionalText(body.request_id ?? body.requestId, 'request_id', Number('64')),
        goal: optionalText(body.goal, 'goal'), secret: optionalText(body.secret, 'secret', Number('200')),
        purpose: optionalText(body.purpose, 'purpose', Number('200')),
        dryRun: body.dry_run === true || body.dryRun === true,
        autoPromoteTrajectory: body.auto_promote_trajectory !== false, proxy: optionalText(body.proxy, 'proxy', Number('200')),
        headless: body.headless === true,
        priority: body.priority === undefined ? undefined : finiteNumber(body.priority, 'priority', ZERO, Number('100')),
        // For provider microsoft_entra the directory tenant is the Entra directory
        // id, not a Weles/Skarbiec binding tenant; the credential layer keeps
        // those apart.
        tenantId: directory
          ? optionalText(directory.tenant_id, 'directory.tenant_id', Number('200')) ?? null
          : optionalText(body.tenant_id ?? body.tenantId, 'tenant_id', Number('200')) ?? null,
        accountEmail: optionalText(body.account_email ?? body.accountEmail, 'account_email', Number('320')),
        accountUpn: directory
          ? optionalText(directory.account_upn, 'directory.account_upn', Number('320'))
          : undefined,
        principalObjectId: directory
          ? optionalText(directory.principal_object_id, 'directory.principal_object_id', Number('200'))
          : undefined,
      };
      if (!request.requestId || !/^[a-f0-9]{64}$/i.test(request.requestId)) {
        throw new Error('request_id must be one 64-character hexadecimal value');
      }
      return request.dryRun ? buildSecretAcquisitionPlan(request) : acquireSecret(request);
    },
    '/v1/echo/automation/health-probes': async () => enqueueHealthProbes(catalog),
    '/v1/echo/automation/login-refresh': async () => enqueueLoginRefresh(catalog),
    '/v1/echo/campaigns/schedule': async (body) => scheduleCampaign(body, catalog),
  };
}

async function workersEnabled() { return (await workerStatus()).enabled; }

async function enqueueHealthProbes(catalog: Record<string, true>) {
  if (!await workersEnabled()) return { success: true, skipped: 'workers_disabled', timestamp: new Date().toISOString() };
  const platforms = ['reddit', 'twitter', 'instagram', 'tiktok', 'linkedin', 'discord', 'github'];
  const now = new Date();
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const queued: Array<{ username: string; platform: string; status: string }> = [];
  let skipped = ZERO;
  for (const name of platforms) {
    const accounts = await listAccounts(name, undefined, 'probe');
    for (const account of accounts) {
      const accountId = identifier(account.id, 'account.id');
      const actionName = action(`${name}_health`, catalog);
      if (await hasRecentAction(accountId, actionName, since)) { skipped += ONE; continue; }
      const scheduledAt = new Date(now.getTime() + Math.floor(Math.random() * Number('300000'))).toISOString();
      await enqueueActions([{ account_id: accountId, action: actionName, platform: name, status: 'queued', scheduled_at: scheduledAt, params: { health_probe: true } }]);
      queued.push({ username: typeof account.username === 'string' ? account.username : '', platform: name, status: 'queued' });
    }
  }
  return { success: true, total_accounts: queued.length + skipped, queued: queued.length, skipped, enqueued: queued, timestamp: now.toISOString() };
}

async function enqueueLoginRefresh(catalog: Record<string, true>) {
  if (!await workersEnabled()) return { success: true, skipped: 'workers_disabled', timestamp: new Date().toISOString() };
  const platforms = ['reddit', 'tiktok', 'instagram', 'twitter', 'linkedin', 'discord', 'github'];
  const queued: Array<{ platform: string; account_id: string }> = [];
  for (const name of platforms) {
    const accounts = await listAccounts(name);
    const actionName = action(`${name}_login`, catalog);
    const now = new Date().toISOString();
    const rows = accounts.map((account) => ({ account_id: identifier(account.id, 'account.id'), action: actionName, platform: name, params: { login_refresh: true }, status: 'queued', scheduled_at: now }));
    if (rows.length) await enqueueActions(rows);
    queued.push(...rows.map((row) => ({ platform: name, account_id: row.account_id })));
  }
  const byPlatform: Record<string, number> = {};
  for (const row of queued) byPlatform[row.platform] = (byPlatform[row.platform] ?? ZERO) + ONE;
  return { queued: queued.length, by_platform: byPlatform, timestamp: new Date().toISOString() };
}

async function scheduleCampaign(body: JsonObject, catalog: Record<string, true>) {
  if (!await workersEnabled()) return { enqueued: ZERO, skipped: ZERO, reason: 'workers_disabled' };
  const campaignId = identifier(body.campaign_id, 'campaign_id');
  const campaignPlatform = platform(body.platform);
  const campaignAction = action(body.action, catalog);
  const paramsTemplate = safeParams(body.params_template, 'params_template');
  const accountIds = body.account_ids === undefined ? [] : stringArray(body.account_ids, 'account_ids', Number('500'));
  const dailyCap = finiteNumber(body.daily_cap_per_account, 'daily_cap_per_account', ONE, Number('1000'));
  const minHours = finiteNumber(body.min_hours_between_per_account, 'min_hours_between_per_account', ZERO, Number('720'));
  const now = new Date();
  const nowIso = now.toISOString();
  const items = await listDueCampaignItems(campaignId, nowIso);
  if (!items.length) return { enqueued: ZERO, skipped: ZERO };
  const allAccounts = await listAccounts(campaignPlatform, accountIds.length ? accountIds : undefined);
  const eligible = allAccounts.filter((account) => {
    if (typeof account.paused_until === 'string' && Date.parse(account.paused_until) > now.getTime()) return false;
    if (account.lifecycle_phase === 'active' || account.lifecycle_phase === 'mature' || account.lifecycle_phase === 'warming') return true;
    return !account.lifecycle_phase && typeof account.created_at === 'string' && now.getTime() - Date.parse(account.created_at) >= Number('1209600000');
  });
  if (!eligible.length) return { enqueued: ZERO, skipped: items.length, reason: 'empty_pool' };
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const cooldown = new Date(now.getTime() - minHours * HOUR_MS).toISOString();
  const recent = await recentAccountActions(eligible.map((account) => identifier(account.id, 'account.id')), dayAgo);
  const budgets: Record<string, { remaining: number; cooldownOk: boolean }> = {};
  for (const account of eligible) budgets[identifier(account.id, 'account.id')] = { remaining: dailyCap, cooldownOk: true };
  for (const row of recent) {
    const accountId = typeof row.account_id === 'string' ? row.account_id : '';
    const budget = budgets[accountId];
    if (!budget || typeof row.action !== 'string') continue;
    if (row.action === campaignAction || row.action.endsWith('_promote')) {
      budget.remaining = Math.max(ZERO, budget.remaining - ONE);
      if (typeof row.started_at === 'string' && row.started_at >= cooldown) budget.cooldownOk = false;
    }
  }
  let enqueued = ZERO;
  let skipped = ZERO;
  let cursor = ZERO;
  for (const item of items) {
    let picked: JsonObject | undefined;
    for (let offset = ZERO; offset < eligible.length; offset += ONE) {
      const index = (cursor + offset) % eligible.length;
      const candidate = eligible.at(index);
      if (!candidate) continue;
      const budget = budgets[identifier(candidate.id, 'account.id')];
      if (budget.remaining > ZERO && budget.cooldownOk) { picked = candidate; cursor = (index + ONE) % eligible.length; break; }
    }
    const itemId = identifier(item.id, 'item.id');
    if (!picked) {
      await updateCampaignItem(itemId, { scheduled_for: new Date(now.getTime() + DAY_MS).toISOString() });
      skipped += ONE;
      continue;
    }
    const paramsOverride = safeParams(item.params_override, 'item.params_override');
    const storedAction = typeof paramsOverride.action === 'string' ? action(paramsOverride.action, catalog) : campaignAction;
    delete paramsOverride.action;
    const accountId = identifier(picked.id, 'account.id');
    const target = text(item.target, 'item.target');
    const rows = await enqueueActions([{
      account_id: accountId, action: storedAction, platform: campaignPlatform, status: 'queued', scheduled_at: nowIso,
      params: { ...paramsTemplate, ...paramsOverride, target_url: target, campaign_item_id: itemId },
    }]);
    const actionLogId = rows.at(ZERO)?.id;
    if (!actionLogId) {
      await updateCampaignItem(itemId, { status: 'failed', error: 'enqueue_failed', completed_at: nowIso });
      skipped += ONE;
      continue;
    }
    await updateCampaignItem(itemId, { status: 'enqueued', action_log_id: actionLogId, account_id: accountId, enqueued_at: nowIso });
    const budget = budgets[accountId];
    budget.remaining -= ONE;
    budget.cooldownOk = false;
    enqueued += ONE;
  }
  return { enqueued, skipped };
}

export function startEchoApiServer() {
  const token = requiredEnv('WELES_ECHO_API_TOKEN');
  if (Buffer.byteLength(token) < MIN_TOKEN_BYTES) throw new Error('WELES_ECHO_API_TOKEN must be at least 32 bytes');
  if (token === process.env.WELES_DATABASE_TOKEN?.trim()) throw new Error('WELES_ECHO_API_TOKEN must be distinct from the Weles database token');
  const expectedHash = hashToken(token);
  const routes = handlers(actionCatalog());
  const port = process.env.WELES_ECHO_API_PORT ? Number(process.env.WELES_ECHO_API_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= ZERO || port > Number('65535')) throw new Error('WELES_ECHO_API_PORT is invalid');
  const server = createServer(async (request, response) => {
    if (!authorized(request, expectedHash)) { send(response, Number('401'), { error: 'unauthorized' }); return; }
    if (request.method !== 'POST') { send(response, Number('405'), { error: 'method_not_allowed' }); return; }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const handler = routes[path];
    if (!handler) { send(response, Number('404'), { error: 'operation_not_found' }); return; }
    try { send(response, Number('200'), { ok: true, data: await handler(await readJson(request)) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      send(response, Number('400'), { ok: false, error: sanitizeOutput(message) });
    }
  });
  server.listen(port, SERVER_HOST, () => console.log(`[weles-echo-api] listening on authenticated loopback ${SERVER_HOST}:${port}`));
  return server;
}

if (require.main === module) startEchoApiServer();
