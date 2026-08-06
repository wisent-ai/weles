import { optionalWelesDatabase, requireWelesDatabase, welesDatabaseHeaders } from '../utils/weles-database.js';
import { acquiredSecretContract, readOptionalWelesServiceSecret, writeWelesAcquiredSecret } from './scoped-service.js';
const ONE = 'x'.length;
const TWENTY = 'xxxxxxxxxxxxxxxxxxxx'.length;
const FIFTY = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.length;
function resendReceivingKey(): string | undefined {
  return readOptionalWelesServiceSecret('resendReceiving', 'api_key');
}

type ActionLogRow = {
  id: string;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  params?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  tenant_id?: string | null;
};

type ResendMessage = {
  id: string;
  to?: Array<string | { email?: string | null }>;
  from?: string | null;
  subject?: string | null;
  created_at?: string | null;
};



type ScannerResult =
  | {
      status: 'validated';
      validated: true;
      validation_status: string;
      vault_item_id: string;
      vault_field: string;
      source_action_log_id: string;
      source_email_id: string;
      next_scheduled_at?: never;
    }
  | {
      status: 'pending';
      validated: false;
      reason: string;
      source_action_log_id: string;
      next_action_log_id: string;
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


function databaseUrl(): string {
  return requireWelesDatabase().url;
}

function headers(): Record<string, string> {
  return welesDatabaseHeaders(requireWelesDatabase(), { 'Content-Type': 'application/json' });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}



function sourceConstraints(row: ActionLogRow): Record<string, unknown> {
  return record(record(row.params).constraints);
}

function isSemanticSubmission(row: ActionLogRow): boolean {
  const constraints = sourceConstraints(row);
  const rowTenant = text(row.tenant_id) || null;
  const constraintTenant = text(constraints.tenant_id) || null;
  return constraints.secret === SEMANTIC_SECRET
    && constraints.provider === 'semantic_scholar'
    && constraints.operation === 'acquire'
    && constraints.vault_item_id === 'weles-semantic-scholar-api'
    && /^[a-f0-9]{64}$/i.test(text(constraints.request_id))
    && rowTenant === constraintTenant;
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
  const response = await fetch(`${databaseUrl()}/rest/v1/${pathAndQuery}`, { headers: headers() });
  if (!response.ok) throw new Error(`Weles database GET failed HTTP ${response.status}`);
  return await response.json() as T;
}


async function restPost<T>(tableAndQuery: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${databaseUrl()}/rest/v1/${tableAndQuery}`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Weles database POST failed HTTP ${response.status}`);
  return await response.json() as T;
}

async function loadSourceSubmission(sourceActionLogId: string | undefined, tenantId: string | null): Promise<ActionLogRow | null> {
  const tenantFilter = tenantId
    ? `tenant_id=eq.${encodeURIComponent(tenantId)}`
    : 'tenant_id=is.null';
  if (sourceActionLogId) {
    const rows = await restGet<ActionLogRow[]>(`account_action_logs?id=eq.${encodeURIComponent(sourceActionLogId)}&${tenantFilter}&select=id,status,started_at,completed_at,tenant_id,params,result&limit=${ONE}`);
    const row = rows[0];
    return row && isSemanticSubmission(row) ? row : null;
  }
  const rows = await restGet<ActionLogRow[]>(`account_action_logs?action=eq.generic_keeper_task&platform=eq.generic&status=eq.completed&${tenantFilter}&select=id,status,started_at,completed_at,tenant_id,params,result&order=completed_at.desc&limit=${TWENTY}`);
  return rows.find(isSemanticSubmission) ?? null;
}

function messageRecipients(message: ResendMessage): string[] {
  return (message.to ?? []).map((entry) => typeof entry === 'string' ? entry : text(entry.email)).map((entry) => entry.toLowerCase());
}

async function listReceivedEmails(after?: string): Promise<{ data: ResendMessage[]; has_more?: boolean }> {
  const params = new URLSearchParams({ limit: '100' });
  if (after) params.set('after', after);
  const response = await fetch(`https://api.resend.com/emails/receiving?${params.toString()}`, {
    headers: { Authorization: `Bearer ${resendReceivingKey()}` },
  });
  if (!response.ok) throw new Error(`Resend receiving list failed HTTP ${response.status}`);
  return await response.json() as { data: ResendMessage[]; has_more?: boolean };
}

async function loadReceivedEmail(id: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${resendReceivingKey()}` },
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



function sourceStartedAt(row: ActionLogRow): number {
  const value = row.started_at ?? row.completed_at ?? '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms - 10 * 60_000 : 0;
}

async function scanMailboxForValidKey(source: ActionLogRow): Promise<{ stored: true; emailId: string; validationStatus: string; emailsScanned: number; matchedEmails: number } | { stored: false; emailsScanned: number; matchedEmails: number }> {
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
        const secret = Buffer.from(candidate, 'utf8');
        try {
          const validation = await validateCandidate(candidate);
          if (!validation.ok) continue;
          const constraints = sourceConstraints(source);
          const tenantId = text(source.tenant_id) || text(constraints.tenant_id) || null;
          writeWelesAcquiredSecret(
            SEMANTIC_SECRET,
            'api_key',
            secret,
            tenantId,
            {
              requestId: text(constraints.request_id),
              operation: text(constraints.operation) || 'acquire',
            },
          );
          return { stored: true, emailId: message.id, validationStatus: validation.status, emailsScanned, matchedEmails };
        } finally {
          secret.fill(Number('0'));
        }
      }
    }
    if (!page.has_more || data.length === 0) break;
    after = data[data.length - 1]?.id;
    if (!after) break;
  }
  return { stored: false, emailsScanned, matchedEmails };
}
async function queuedFollowupId(sourceActionLogId: string, tenantId?: string | null): Promise<string | null> {
  const currentActionLogId = process.env.ACTION_LOG_ID?.trim() ?? '';
  const tenantFilter = tenantId
    ? `&tenant_id=eq.${encodeURIComponent(tenantId)}`
    : '&tenant_id=is.null';
  const rows = await restGet<ActionLogRow[]>(`account_action_logs?action=eq.${FOLLOWUP_ACTION}&status=in.(queued,running)&select=id,tenant_id,params&limit=${FIFTY}${tenantFilter}`);
  return rows.find((row) => row.id !== currentActionLogId
    && text(record(row.params).source_action_log_id) === sourceActionLogId)?.id ?? null;
}

export async function queueSemanticScholarFollowup(sourceActionLogId: string, delayMs = ''.length, attempt = ''.length, tenantId?: string | null): Promise<{ queued: boolean; action_log_id: string; scheduled_at?: string }> {
  const existing = await queuedFollowupId(sourceActionLogId, tenantId);
  if (existing) return { queued: false, action_log_id: existing };
  const scheduledAt = new Date(Date.now() + delayMs).toISOString();
  const rows = await restPost<Array<{ id?: string | null }>>('account_action_logs?select=id', {
    action: FOLLOWUP_ACTION,
    platform: FOLLOWUP_PLATFORM,
    status: 'queued',
    scheduled_at: scheduledAt,
    priority: 25,
    queued_by: 'secret-acquisition-followup',
    tenant_id: tenantId ?? null,
    params: {
      source_action_log_id: sourceActionLogId,
      attempt,
      secret: SEMANTIC_SECRET,
      purpose: 'lem',
      tenant_id: tenantId ?? null,
    },
  });
  const actionLogId = rows[0]?.id;
  if (!actionLogId) throw new Error('Semantic Scholar follow-up insert did not return an action log id');
  return { queued: true, action_log_id: actionLogId, scheduled_at: scheduledAt };
}

function nextBackoffMs(attempt: number): number {
  const minutes = Math.min(360, 15 * Math.pow(2, Math.max(0, attempt)));
  return minutes * 60_000;
}

export async function runSemanticScholarKeyFollowup(sourceActionLogId?: string, attemptArg?: number, tenantId: string | null = null): Promise<ScannerResult> {
  if (!optionalWelesDatabase()) {
    return { status: 'needs_configuration', validated: false, reason: 'missing weles-database launcher configuration', next_scheduled_at: null };
  }
  if (!resendReceivingKey()) {
    return { status: 'needs_configuration', validated: false, reason: 'missing exact Weles Resend receiving grant', next_scheduled_at: null };
  }
  const source = await loadSourceSubmission(sourceActionLogId, tenantId);
  if (!source) return { status: 'source_not_found', validated: false, reason: 'no completed Semantic Scholar submission found', next_scheduled_at: null };
  if (!identityEmail(source)) return { status: 'target_email_missing', validated: false, reason: 'submitted run has no generated email in result metadata', source_action_log_id: source.id, next_scheduled_at: null };

  const scan = await scanMailboxForValidKey(source);
  if (scan.stored) {
    const contract = acquiredSecretContract(SEMANTIC_SECRET);
    if (!contract) throw new Error('missing exact Semantic Scholar Skarbiec contract');
    return {
      status: 'validated',
      validated: true,
      validation_status: scan.validationStatus,
      vault_item_id: contract.item,
      vault_field: contract.field,
      source_action_log_id: source.id,
      source_email_id: scan.emailId,
    };
  }

  const attempt = Number.isFinite(attemptArg) ? Number(attemptArg) : 0;
  const maxAttempts = Math.max(1, Number(process.env.SEMANTIC_SCHOLAR_FOLLOWUP_MAX_ATTEMPTS ?? '96'));
  if (attempt + 1 >= maxAttempts) {
    return { status: 'expired', validated: false, reason: 'no Semantic Scholar key email found before follow-up expiry', source_action_log_id: source.id, emails_scanned: scan.emailsScanned, matched_emails: scan.matchedEmails, next_scheduled_at: null };
  }
  const queued = await queueSemanticScholarFollowup(source.id, nextBackoffMs(attempt), attempt + ONE, tenantId);
  return { status: 'pending', validated: false, reason: 'no Semantic Scholar key email found yet', source_action_log_id: source.id, next_action_log_id: queued.action_log_id, emails_scanned: scan.emailsScanned, matched_emails: scan.matchedEmails, next_scheduled_at: queued.scheduled_at ?? null };
}
