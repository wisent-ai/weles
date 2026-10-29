// The Semantic Scholar API-key follow-up: after a key request was submitted,
// the identity's inbox is read (semantic-scholar/mailbox.ts) until the key
// arrives and is stored, or the stated number of reads runs out, each later
// read queued as its own run after the stated interval.

import { readSetting, writeSetting } from '../state/skarbiec-records.js';
import { readWelesRun, submitWelesRun } from '../worker/run-submit/index.js';
import { acquiredSecretContract } from './scoped-service.js';
import { ORGANIZATION_VARIABLE } from '../utils/email/skrzynka-inbox.js';
import { isRequestId } from './request-id.js';
import {
  SEMANTIC_SECRET,
  scanMailboxForValidKey,
} from './semantic-scholar/mailbox.js';

type ActionLogRow = {
  id: string;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  params?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  tenant_id?: string | null;
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
      status:
        | 'needs_configuration'
        | 'source_not_found'
        | 'target_email_missing'
        | 'expired';
      validated: false;
      reason: string;
      source_action_log_id?: string;
      emails_scanned?: number;
      matched_emails?: number;
      next_scheduled_at?: null;
    };

const FOLLOWUP_ACTION = 'semanticscholar_key_followup';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A non-empty string, or undefined. */
function stated(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function sourceConstraints(row: ActionLogRow): Record<string, unknown> {
  return record(record(row.params).constraints);
}

/** The tenant a submission names, on its row or in its constraints; null for the operator's own. */
function submissionTenant(row: ActionLogRow): string | null {
  const tenant =
    stated(row.tenant_id) ?? stated(sourceConstraints(row).tenant_id);
  return tenant === undefined ? null : tenant;
}

function isSemanticSubmission(row: ActionLogRow): boolean {
  const constraints = sourceConstraints(row);
  return (
    constraints.secret === SEMANTIC_SECRET &&
    constraints.provider === 'semantic_scholar' &&
    constraints.operation === 'acquire' &&
    constraints.vault_item_id === 'weles-semantic-scholar-api' &&
    isRequestId(constraints.request_id) &&
    stated(row.tenant_id) === stated(constraints.tenant_id)
  );
}

/** The email of the identity the submission generated, as its result records it. */
function identityEmail(row: ActionLogRow): string | undefined {
  return stated(record(record(row.result).identity).email)?.trim();
}

async function loadSourceSubmission(
  sourceActionLogId: string | undefined,
  tenantId: string | null,
): Promise<ActionLogRow | null> {
  if (!sourceActionLogId) return null;
  const row = await readWelesRun<ActionLogRow>(sourceActionLogId);
  if (!row) return null;
  const normalized = { ...row, id: row.id || sourceActionLogId };
  return isSemanticSubmission(normalized) &&
    submissionTenant(normalized) === tenantId
    ? normalized
    : null;
}

/** When the submission ran, if its row says; mail older than that is not its key. */
function sourceStartedAt(row: ActionLogRow): number | undefined {
  const when = stated(row.started_at) ?? stated(row.completed_at);
  const ms = when === undefined ? Number.NaN : Date.parse(when);
  return Number.isFinite(ms) ? ms : undefined;
}

export async function queueSemanticScholarFollowup(
  sourceActionLogId: string,
  delayMs: number,
  attempt: number,
  tenantId: string | null,
): Promise<{
  queued: boolean;
  action_log_id: string;
  scheduled_at: string | null;
}> {
  const key = `semantic_followup_${sourceActionLogId}_${attempt}`
    .replace(/[^a-z\d_]/gi, '_')
    .toLowerCase();
  const existing = readSetting<string | null>(key, null);
  if (existing)
    return { queued: false, action_log_id: existing, scheduled_at: null };
  const scheduledAt = new Date(Date.now() + delayMs).toISOString();
  const jobId = await submitWelesRun({
    action: FOLLOWUP_ACTION,
    params: {
      source_action_log_id: sourceActionLogId,
      attempt,
      delay_ms: delayMs,
      secret: SEMANTIC_SECRET,
      purpose: 'lem',
      tenant_id: tenantId,
    },
  });
  writeSetting(key, jobId);
  return { queued: true, action_log_id: jobId, scheduled_at: scheduledAt };
}

// How often the inbox is read again and for how many reads are the caller's:
// Semantic Scholar states no delivery time for its key email.
function statedFollowupCount(name: string, what: string): number {
  const raw = process.env[name];
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || !(value >= Number.MIN_VALUE)) {
    throw new Error(
      `${name} is ${raw ? `"${raw}", not a whole number above zero` : 'not set'}: ${what}; nothing is assumed`,
    );
  }
  return value;
}

/**
 * Read of the inbox number `attempt` (counted from the first read, which is
 * attempt 0) for the key of submission `sourceActionLogId`.
 */
export async function runSemanticScholarKeyFollowup(
  sourceActionLogId: string | undefined,
  attempt: number,
  tenantId: string | null,
): Promise<ScannerResult> {
  if (!process.env[ORGANIZATION_VARIABLE]?.trim()) {
    return {
      status: 'needs_configuration',
      validated: false,
      reason: `${ORGANIZATION_VARIABLE} names no Skrzynka organization, so the key email cannot be read`,
      next_scheduled_at: null,
    };
  }
  const source = await loadSourceSubmission(sourceActionLogId, tenantId);
  if (!source)
    return {
      status: 'source_not_found',
      validated: false,
      reason: 'no completed Semantic Scholar submission found',
      next_scheduled_at: null,
    };
  const target = identityEmail(source);
  if (!target)
    return {
      status: 'target_email_missing',
      validated: false,
      reason: 'submitted run has no generated email in result.identity',
      source_action_log_id: source.id,
      next_scheduled_at: null,
    };
  const constraints = sourceConstraints(source);
  const scan = await scanMailboxForValidKey({
    target: target.toLowerCase(),
    since: sourceStartedAt(source),
    tenantId: submissionTenant(source),
    requestId: String(constraints.request_id),
    operation: String(constraints.operation),
  });
  if (scan.stored) {
    const contract = acquiredSecretContract(SEMANTIC_SECRET);
    if (!contract)
      throw new Error('missing exact Semantic Scholar Skarbiec contract');
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

  const maxAttempts = statedFollowupCount(
    'SEMANTIC_SCHOLAR_FOLLOWUP_MAX_ATTEMPTS',
    'how many times the inbox is read for the Semantic Scholar key email',
  );
  const intervalMs = statedFollowupCount(
    'SEMANTIC_SCHOLAR_FOLLOWUP_INTERVAL_MS',
    'how long to wait between reads of the inbox for the Semantic Scholar key email',
  );
  let next = attempt;
  next++;
  if (next >= maxAttempts) {
    return {
      status: 'expired',
      validated: false,
      reason: 'no Semantic Scholar key email found before follow-up expiry',
      source_action_log_id: source.id,
      emails_scanned: scan.emailsScanned,
      matched_emails: scan.matchedEmails,
      next_scheduled_at: null,
    };
  }
  const queued = await queueSemanticScholarFollowup(
    source.id,
    intervalMs,
    next,
    tenantId,
  );
  return {
    status: 'pending',
    validated: false,
    reason: 'no Semantic Scholar key email found yet',
    source_action_log_id: source.id,
    next_action_log_id: queued.action_log_id,
    emails_scanned: scan.emailsScanned,
    matched_emails: scan.matchedEmails,
    next_scheduled_at: queued.scheduled_at,
  };
}
