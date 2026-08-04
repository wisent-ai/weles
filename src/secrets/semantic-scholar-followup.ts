import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

type ActionLogRow = {
  id: string;
  status?: string | null;
  started_at?: string | null;
  tenant_id?: string | null;
  completed_at?: string | null;
  params?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
};

type ResendMessage = {
  id: string;
  to?: Array<string | { email?: string | null }>;
  from?: string | null;
  subject?: string | null;
  created_at?: string | null;
};

type ServiceCredentialRow = { id: string };

type RuntimeInstallStatus = {
  secrets_env_written: boolean;
  secrets_env_mode: string | null;
  launchctl_present: boolean | null;
  launchctl_value_length: number | null;
};

type ScannerResult =
  | {
      status: 'validated';
      validated: true;
      validation_status: string;
      preview: string;
      service_credential_id: string | null;
      source_action_log_id: string;
      source_email_id: string;
      runtime_installed: boolean;
      runtime_install: RuntimeInstallStatus;
      next_scheduled_at?: never;
    }
  | {
      status: 'pending';
      validated: false;
      reason: string;
      source_action_log_id: string;
      emails_scanned: number;
      matched_emails: number;
      next_scheduled_at: string | null;
    }
  | {
      status: 'needs_configuration' | 'source_not_found' | 'target_email_missing' | 'expired';
      validated: false;
      reason: string;
      source_action_log_id?: string;
      emails_scanned?: number;
      matched_emails?: number;
      next_scheduled_at?: null;
    };

const SEMANTIC_SECRET = 'semantic_scholar.api_key';
const FOLLOWUP_ACTION = 'semanticscholar_key_followup';
const FOLLOWUP_PLATFORM = 'semanticscholar';
const VALIDATION_URL = 'https://api.semanticscholar.org/graph/v1/paper/search?query=test&limit=1&fields=title';

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function supabaseUrl(): string {
  return (env('SUPABASE_URL') || env('NEXT_PUBLIC_SUPABASE_URL')).replace(/\/$/, '');
}

function headers(): Record<string, string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function previewSecret(value: string): string {
  return value.length <= 12 ? `${value.slice(0, 2)}…${value.slice(-2)}` : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sourceConstraints(row: ActionLogRow): Record<string, unknown> {
  return record(record(row.params).constraints);
}

function isSemanticSubmission(row: ActionLogRow): boolean {
  const constraints = sourceConstraints(row);
  if (constraints.secret === SEMANTIC_SECRET) return true;
  const result = record(row.result);
  const generic = record(result.generic_browser_task);
  const value = record(generic.value);
  return text(value.status) === 'submitted' && /Semantic Scholar/i.test(text(value.next_steps) + ' ' + text(value.confirmation));
}

function identityEmail(row: ActionLogRow): string {
  const result = record(row.result);
  const identity = record(result.identity);
  const direct = text(identity.email).trim();
  if (direct) return direct;
  const session = record(result.session);
  const envAll = record(session.env_all);
  return ['SEMANTIC_SCHOLAR_NEW_EMAIL', 'GENERIC_NEW_EMAIL', 'UW_EMAIL', 'VL_EMAIL']
    .map((key) => text(envAll[key]).trim())
    .find(Boolean) ?? '';
}

async function restGet<T>(pathAndQuery: string): Promise<T> {
  const response = await fetch(`${supabaseUrl()}/rest/v1/${pathAndQuery}`, { headers: headers() });
  if (!response.ok) throw new Error(`Supabase GET failed HTTP ${response.status}`);
  return await response.json() as T;
}

async function restPatch(pathAndQuery: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${supabaseUrl()}/rest/v1/${pathAndQuery}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Supabase PATCH failed HTTP ${response.status}`);
}

async function restPost<T>(tableAndQuery: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${supabaseUrl()}/rest/v1/${tableAndQuery}`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Supabase POST failed HTTP ${response.status}`);
  return await response.json() as T;
}

async function loadSourceSubmission(sourceActionLogId?: string): Promise<ActionLogRow | null> {
  if (sourceActionLogId) {
    const rows = await restGet<ActionLogRow[]>(`account_action_logs?id=eq.${encodeURIComponent(sourceActionLogId)}&select=id,status,started_at,completed_at,params,result&limit=1`);
    const row = rows[0];
    return row && isSemanticSubmission(row) ? row : null;
  }
  const rows = await restGet<ActionLogRow[]>('account_action_logs?action=eq.generic_keeper_task&platform=eq.generic&status=eq.completed&select=id,status,started_at,completed_at,params,result&order=completed_at.desc&limit=20');
  return rows.find(isSemanticSubmission) ?? null;
}

function messageRecipients(message: ResendMessage): string[] {
  return (message.to ?? []).map((entry) => typeof entry === 'string' ? entry : text(entry.email)).map((entry) => entry.toLowerCase());
}

async function listReceivedEmails(after?: string): Promise<{ data: ResendMessage[]; has_more?: boolean }> {
  const params = new URLSearchParams({ limit: '100' });
  if (after) params.set('after', after);
  const response = await fetch(`https://api.resend.com/emails/receiving?${params.toString()}`, {
    headers: { Authorization: `Bearer ${env('RESEND_RECEIVING_API_KEY')}` },
  });
  if (!response.ok) throw new Error(`Resend receiving list failed HTTP ${response.status}`);
  return await response.json() as { data: ResendMessage[]; has_more?: boolean };
}

async function loadReceivedEmail(id: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env('RESEND_RECEIVING_API_KEY')}` },
  });
  if (!response.ok) throw new Error(`Resend receiving message failed HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function contentForCandidateExtraction(message: Record<string, unknown>): string {
  return [message.subject, message.text, message.html].map(text).join('\n');
}

export function extractSemanticScholarKeyCandidates(content: string): string[] {
  const candidates = new Set<string>();
  const normalized = content.replace(/&amp;/g, '&').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const contextual = [
    /(?:api\s*key|x-api-key|secret\s*key|access\s*key)\s*(?:is|:|=)?\s*([A-Za-z0-9][A-Za-z0-9._-]{19,127})/gi,
    /(?:SEMANTIC_SCHOLAR_API_KEY|S2_API_KEY)\s*(?:=|:)\s*([A-Za-z0-9][A-Za-z0-9._-]{19,127})/g,
  ];
  for (const pattern of contextual) {
    for (const match of normalized.matchAll(pattern)) candidates.add(match[1]);
  }
  return [...candidates].filter((candidate) => {
    if (candidate.includes('@')) return false;
    if (/^https?:/i.test(candidate)) return false;
    if (/^(semantic|scholar|received|request|information|patience)$/i.test(candidate)) return false;
    return /[0-9]/.test(candidate) && /[A-Za-z]/.test(candidate);
  });
}

async function validateCandidate(candidate: string): Promise<{ ok: boolean; status: string }> {
  try {
    const response = await fetch(VALIDATION_URL, { headers: { 'x-api-key': candidate } });
    return { ok: response.ok, status: `HTTP ${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: `validation error: ${message.slice(0, 120)}` };
  }
}

async function installForLemRuntime(secret: string): Promise<RuntimeInstallStatus> {
  const secretsPath = join(homedir(), '.lem', 'secrets.env');
  await mkdir(dirname(secretsPath), { recursive: true });
  let existing = '';
  try { existing = await readFile(secretsPath, 'utf8'); } catch { existing = ''; }
  const retained = existing.split(/\r?\n/).filter((line) => line.trim() && !/^\s*(SEMANTIC_SCHOLAR_API_KEY|S2_API_KEY)=/.test(line));
  retained.push(`SEMANTIC_SCHOLAR_API_KEY=${shellSingleQuote(secret)}`);
  retained.push(`S2_API_KEY=${shellSingleQuote(secret)}`);
  await writeFile(secretsPath, `${retained.join('\n')}\n`, { mode: 0o600 });
  await chmod(secretsPath, 0o600).catch(() => {});
  let launchctlPresent: boolean | null = null;
  let launchctlValueLength: number | null = null;
  if (process.platform === 'darwin') {
    spawnSync('/bin/launchctl', ['setenv', 'SEMANTIC_SCHOLAR_API_KEY', secret], { stdio: 'ignore' });
    spawnSync('/bin/launchctl', ['setenv', 'S2_API_KEY', secret], { stdio: 'ignore' });
    const getenv = spawnSync('/bin/launchctl', ['getenv', 'SEMANTIC_SCHOLAR_API_KEY'], { encoding: 'utf8' });
    const value = typeof getenv.stdout === 'string' ? getenv.stdout.trim() : '';
    launchctlPresent = value.length > 0;
    launchctlValueLength = value.length;
  }
  process.env.SEMANTIC_SCHOLAR_API_KEY = secret;
  process.env.S2_API_KEY = secret;
  const fileStat = await stat(secretsPath).catch(() => null);
  return {
    secrets_env_written: !!fileStat,
    secrets_env_mode: fileStat ? `0${(fileStat.mode & 0o777).toString(8)}` : null,
    launchctl_present: launchctlPresent,
    launchctl_value_length: launchctlValueLength,
  };
}

async function persistServiceCredential(source: ActionLogRow, sourceEmailId: string, secret: string, validationStatus: string): Promise<string | null> {
  const metadata = {
    source: 'semantic_scholar_mailbox_followup',
    source_action_log_id: source.id,
    source_email_id: sourceEmailId,
    validation_status: validationStatus,
    provider: 'semantic_scholar',
    capabilities: ['paper_search', 'citation_metadata', 'related_papers'],
    runtime_env_installed: true,
    captured_at: new Date().toISOString(),
  };
  const patch = {
    id: 'semantic_scholar_api_key',
    display_name: 'Semantic Scholar',
    category: 'auth',
    api_key_env_var: 'SEMANTIC_SCHOLAR_API_KEY',
    api_key_preview: previewSecret(secret),
    notes: `Semantic Scholar API key validated and installed into LEM runtime environment from Weles follow-up ${source.id}.`,
    metadata,
    updated_at: new Date().toISOString(),
  };
  const existing = await restGet<ServiceCredentialRow[]>('service_credentials?id=eq.semantic_scholar_api_key&select=id&limit=1');
  const id = existing[0]?.id ?? null;
  if (id) {
    await restPatch(`service_credentials?id=eq.${encodeURIComponent(id)}`, patch);
    return id;
  }
  const rows = await restPost<ServiceCredentialRow[]>('service_credentials?select=id', patch);
  return rows[0]?.id ?? null;
}

function sourceStartedAt(row: ActionLogRow): number {
  const value = row.started_at ?? row.completed_at ?? '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms - 10 * 60_000 : 0;
}

async function scanMailboxForValidKey(source: ActionLogRow): Promise<{ secret: string; emailId: string; validationStatus: string; emailsScanned: number; matchedEmails: number } | { secret: null; emailsScanned: number; matchedEmails: number }> {
  const target = identityEmail(source).toLowerCase();
  const minCreatedAt = sourceStartedAt(source);
  const maxPages = Math.max(1, Math.min(Number(process.env.SEMANTIC_SCHOLAR_FOLLOWUP_MAX_PAGES ?? '8'), 20));
  let after: string | undefined;
  let emailsScanned = 0;
  let matchedEmails = 0;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = await listReceivedEmails(after);
    const data = page.data ?? [];
    emailsScanned += data.length;
    for (const message of data) {
      const createdAt = Date.parse(message.created_at ?? '');
      if (Number.isFinite(createdAt) && createdAt < minCreatedAt) continue;
      if (!messageRecipients(message).includes(target)) continue;
      matchedEmails += 1;
      const full = await loadReceivedEmail(message.id);
      const content = contentForCandidateExtraction(full);
      for (const candidate of extractSemanticScholarKeyCandidates(content)) {
        const validation = await validateCandidate(candidate);
        if (validation.ok) return { secret: candidate, emailId: message.id, validationStatus: validation.status, emailsScanned, matchedEmails };
      }
    }
    if (!page.has_more || data.length === 0) break;
    after = data[data.length - 1]?.id;
    if (!after) break;
  }
  return { secret: null, emailsScanned, matchedEmails };
}
async function currentTenantId(): Promise<string | undefined> {
  const actionLogId = env('ACTION_LOG_ID');
  if (!actionLogId) return undefined;
  const rows = await restGet<ActionLogRow[]>(
    `account_action_logs?id=eq.${encodeURIComponent(actionLogId)}&select=tenant_id&limit=1`,
  );
  return text(rows[0]?.tenant_id).trim() || undefined;
}

async function queuedFollowup(
  sourceActionLogId: string,
  tenantId?: string,
): Promise<ActionLogRow | null> {
  const currentActionLogId = env('ACTION_LOG_ID');
  const tenantFilter = tenantId ? `&tenant_id=eq.${encodeURIComponent(tenantId)}` : '';
  const rows = await restGet<ActionLogRow[]>(
    `account_action_logs?action=eq.${FOLLOWUP_ACTION}&status=in.(queued,running)${tenantFilter}&select=id,params&limit=50`,
  );
  return rows.find(
    (row) => row.id !== currentActionLogId
      && text(record(row.params).source_action_log_id) === sourceActionLogId,
  ) ?? null;
}

export async function queueSemanticScholarFollowup(
  sourceActionLogId: string,
  delayMs = 0,
  attempt = 0,
  tenantId?: string,
): Promise<{ queued: boolean; action_log_id: string; scheduled_at?: string }> {
  const existing = await queuedFollowup(sourceActionLogId, tenantId);
  if (existing) {
    return {
      queued: false,
      action_log_id: existing.id,
    };
  }
  const scheduledAt = new Date(Date.now() + delayMs).toISOString();
  const rows = await restPost<ServiceCredentialRow[]>('account_action_logs?select=id', {
    ...(tenantId ? { tenant_id: tenantId } : {}),
    action: FOLLOWUP_ACTION,
    platform: FOLLOWUP_PLATFORM,
    status: 'queued',
    scheduled_at: scheduledAt,
    priority: 25,
    queued_by: 'secret-acquisition-followup',
    params: {
      source_action_log_id: sourceActionLogId,
      attempt,
      secret: SEMANTIC_SECRET,
      purpose: 'lem',
    },
  });
  const actionLogId = rows[0]?.id;
  if (!actionLogId) throw new Error('Semantic Scholar follow-up queue insert returned no action log id');
  return { queued: true, action_log_id: actionLogId, scheduled_at: scheduledAt };
}

function nextBackoffMs(attempt: number): number {
  const minutes = Math.min(360, 15 * Math.pow(2, Math.max(0, attempt)));
  return minutes * 60_000;
}

export async function runSemanticScholarKeyFollowup(sourceActionLogId?: string, attemptArg?: number): Promise<ScannerResult> {
  if (!supabaseUrl() || !env('SUPABASE_SERVICE_ROLE_KEY')) {
    return { status: 'needs_configuration', validated: false, reason: 'missing Supabase service configuration', next_scheduled_at: null };
  }
  if (!env('RESEND_RECEIVING_API_KEY')) {
    return { status: 'needs_configuration', validated: false, reason: 'missing RESEND_RECEIVING_API_KEY', next_scheduled_at: null };
  }
  const source = await loadSourceSubmission(sourceActionLogId);
  if (!source) return { status: 'source_not_found', validated: false, reason: 'no completed Semantic Scholar submission found', next_scheduled_at: null };
  if (!identityEmail(source)) return { status: 'target_email_missing', validated: false, reason: 'submitted run has no generated email in result metadata', source_action_log_id: source.id, next_scheduled_at: null };

  const scan = await scanMailboxForValidKey(source);
  if (scan.secret) {
    const runtimeInstall = await installForLemRuntime(scan.secret);
    const serviceCredentialId = await persistServiceCredential(source, scan.emailId, scan.secret, scan.validationStatus);
    return {
      status: 'validated',
      validated: true,
      validation_status: scan.validationStatus,
      preview: previewSecret(scan.secret),
      service_credential_id: serviceCredentialId,
      source_action_log_id: source.id,
      source_email_id: scan.emailId,
      runtime_installed: runtimeInstall.secrets_env_written && (runtimeInstall.launchctl_present !== false),
      runtime_install: runtimeInstall,
    };
  }

  const attempt = Number.isFinite(attemptArg) ? Number(attemptArg) : 0;
  const maxAttempts = Math.max(1, Number(process.env.SEMANTIC_SCHOLAR_FOLLOWUP_MAX_ATTEMPTS ?? '96'));
  if (attempt + 1 >= maxAttempts) {
    return { status: 'expired', validated: false, reason: 'no Semantic Scholar key email found before follow-up expiry', source_action_log_id: source.id, emails_scanned: scan.emailsScanned, matched_emails: scan.matchedEmails, next_scheduled_at: null };
  }
  const queued = await queueSemanticScholarFollowup(
    source.id,
    nextBackoffMs(attempt),
    attempt + 1,
    await currentTenantId(),
  );
  return { status: 'pending', validated: false, reason: 'no Semantic Scholar key email found yet', source_action_log_id: source.id, emails_scanned: scan.emailsScanned, matched_emails: scan.matchedEmails, next_scheduled_at: queued.scheduled_at ?? null };
}
