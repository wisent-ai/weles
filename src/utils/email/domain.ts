import { resolveMx } from 'node:dns/promises';
import { readSetting, writeSetting } from '../../state/skarbiec-records.js';

const MX_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SIGNUPS_PER_DOMAIN = 999;
const DOMAIN_STATE_KEY = 'inbound_email_domains';
const mxCache = new Map<string, { ok: boolean; at: number }>();
const PLATFORM_MAX_SIGNUPS: Record<string, number> = {
  tiktok: Number(process.env.TIKTOK_MAX_SIGNUPS_PER_DOMAIN ?? 500),
};

export type DomainRow = {
  domain: string;
  status: 'active' | 'pending' | 'mx_broken';
  signup_count: number;
  block_count?: number;
  last_used_at?: string;
  last_block_at?: string;
  registered_at?: string;
  mx_configured_at?: string;
  resend_verified_at?: string | null;
  provider?: string;
  metadata?: Record<string, any>;
  updated_at?: string;
};

export function readDomainRows(): DomainRow[] {
  const rows = readSetting<DomainRow[]>(DOMAIN_STATE_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

export function writeDomainRows(rows: DomainRow[]): void {
  writeSetting(DOMAIN_STATE_KEY, rows);
}

async function hasValidMx(domain: string): Promise<boolean> {
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < MX_CACHE_TTL_MS) return cached.ok;
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
    try { ok = (await resolveMx(domain)).length > 0; } catch { ok = false; }
    if (!ok && attempt < 2) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 600);
      await promise;
    }
  }
  mxCache.set(domain, { ok, at: Date.now() });
  return ok;
}

function envDerived(): string {
  const domains = process.env.AGENT_EMAIL_DOMAINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  if (domains.length) return domains[Math.floor(Math.random() * domains.length)];
  return process.env.AGENT_DOMAIN ?? 'wisentmedia.com';
}

function platformBlock(row: DomainRow, platform?: string): boolean {
  if (!platform) return false;
  const key = platform.toLowerCase();
  const metadata = row.metadata ?? {};
  return Boolean(metadata.platform_blocks?.[key] ?? metadata.blocked_platforms?.[key]);
}

async function pickStoredDomain(platform?: string): Promise<string | null> {
  const rows = readDomainRows();
  const now = new Date().toISOString();
  let changed = false;
  for (const row of rows.filter((candidate) => candidate.status === 'mx_broken')) {
    if (await hasValidMx(row.domain)) {
      row.status = 'active';
      row.updated_at = now;
      changed = true;
    }
  }
  const maximum = platform ? (PLATFORM_MAX_SIGNUPS[platform.toLowerCase()] ?? MAX_SIGNUPS_PER_DOMAIN) : MAX_SIGNUPS_PER_DOMAIN;
  const candidates = rows
    .filter((row) => row.status === 'active' && row.signup_count < maximum && !platformBlock(row, platform))
    .sort((left, right) => left.signup_count - right.signup_count || String(left.last_used_at ?? '').localeCompare(String(right.last_used_at ?? '')));
  for (const row of candidates) {
    if (!(await hasValidMx(row.domain))) {
      row.status = 'mx_broken';
      row.updated_at = now;
      changed = true;
      continue;
    }
    row.last_used_at = now;
    writeDomainRows(rows);
    return row.domain;
  }
  if (changed) writeDomainRows(rows);
  if (platform && rows.length) throw new Error(`domain_unavailable: no active inbound domains below ${maximum} signups for ${platform}`);
  return null;
}

export async function pickDomain(platform?: string): Promise<string> {
  const forced = process.env.FORCE_EMAIL_DOMAIN?.trim();
  if (forced) return forced;
  return (await pickStoredDomain(platform)) ?? envDerived();
}

export async function markSignupSuccess(emailOrDomain: string, platform?: string): Promise<void> {
  const domain = emailOrDomain.includes('@') ? emailOrDomain.split('@')[1] : emailOrDomain;
  const rows = readDomainRows();
  const row = rows.find((candidate) => candidate.domain === domain);
  if (!row) return;
  const now = new Date().toISOString();
  row.signup_count = (row.signup_count ?? 0) + 1;
  row.last_used_at = now;
  row.updated_at = now;
  if (platform) {
    row.metadata = {
      ...(row.metadata ?? {}),
      platform_success: { ...(row.metadata?.platform_success ?? {}), [platform.toLowerCase()]: now },
    };
  }
  writeDomainRows(rows);
}

export async function reportBlocked(domainOrEmail: string, reason?: string, platform?: string): Promise<void> {
  const domain = domainOrEmail.includes('@') ? domainOrEmail.split('@')[1] : domainOrEmail;
  const rows = readDomainRows();
  const row = rows.find((candidate) => candidate.domain === domain);
  if (!row) return;
  const now = new Date().toISOString();
  const platformKey = platform?.toLowerCase();
  row.block_count = (row.block_count ?? 0) + 1;
  row.last_block_at = now;
  row.updated_at = now;
  row.metadata = {
    ...(row.metadata ?? {}),
    last_block_reason: reason ?? 'unspecified',
    ...(platformKey ? {
      platform_blocks: {
        ...(row.metadata?.platform_blocks ?? {}),
        [platformKey]: { reason: reason ?? 'unspecified', at: now },
      },
    } : {}),
  };
  writeDomainRows(rows);
}
