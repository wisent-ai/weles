/**
 * Inbound email domain rotator.
 *
 * Picks a domain for each signup from the `inbound_email_domains` Supabase table,
 * preferring least-recently-used active domains. When the table is unreachable
 * or empty, derives one from env vars: AGENT_EMAIL_DOMAINS csv, then AGENT_DOMAIN,
 * then wisentmedia.com.
 *
 * All listed domains are expected to live in a single Resend receiving workspace,
 * so one RESEND_RECEIVING_API_KEY can poll inboxes across every domain.
 *
 * Live MX validation: every candidate row gets dns.resolveMx() before being
 * returned. Domains with empty MX are PATCH'd to status='mx_broken' on the spot
 * and skipped to the next candidate. Self-heals DNS drift on the trajectory's
 * own failure path — no separate cron needed.
 */

import { resolveMx } from 'node:dns/promises';

const MX_CACHE_TTL_MS = 5 * 60 * 1000;
const mxCache: Map<string, { ok: boolean; at: number }> = new Map();

// Up to 3 resolveMx attempts with 600ms gap before declaring MX missing.
// Single-shot lookup used to permanently flip the row to mx_broken on any
// transient SERVFAIL/timeout/empty-response, and there was no recovery —
// so the rotator drained to wisentmedia.com while every other domain sat
// invisible (verified 2026-05-18: 7/8 .com rows mx_broken, MX live in DNS).
async function hasValidMx(domain: string): Promise<boolean> {
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < MX_CACHE_TTL_MS) return cached.ok;
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    try {
      const records = await resolveMx(domain);
      if (Array.isArray(records) && records.length > 0) ok = true;
    } catch { /* retry */ }
    if (!ok && i < 2) await new Promise((r) => setTimeout(r, 600)); // allow-raw-playwright: server-side DNS retry backoff, not browser-driving
  }
  mxCache.set(domain, { ok, at: Date.now() });
  return ok;
}

// Opportunistic self-heal for false-positive mx_broken rows. Sampled on
// every pickFromDb call (limit 5, only rows untouched >1h). Without this,
// once a domain drifted into mx_broken on a single transient DNS blip it
// stayed invisible forever — the rotator drained to wisentmedia.com.
async function recheckMxBroken(sb: { url: string; key: string }): Promise<void> {
  try {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${sb.url}/rest/v1/inbound_email_domains?status=eq.mx_broken&or=(updated_at.lt.${encodeURIComponent(hourAgo)},updated_at.is.null)&order=updated_at.asc.nullsfirst&limit=5&select=domain`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!res.ok) return;
    const rows = (await res.json()) as Array<{ domain: string }>;
    for (const r of rows) {
      mxCache.delete(r.domain);
      if (await hasValidMx(r.domain)) {
        await fetch(`${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(r.domain)}`, {
          method: 'PATCH',
          headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'active', updated_at: new Date().toISOString() }),
        });
        console.log(`[domain] auto-recovered ${r.domain} from mx_broken (MX now resolves)`);
      }
    }
  } catch (e: any) { console.log(`[domain] recheckMxBroken err: ${e?.message?.slice(0, 80)}`); }
}

async function markMxBroken(sb: { url: string; key: string }, domain: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    const res = await fetch(`${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'mx_broken', updated_at: now }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (te: any) { body = `<read err: ${te?.message ?? ''}>`; }
      console.log(`[domain] mx_broken PATCH ${domain} HTTP ${res.status}: ${body.slice(0, 160)}`);
      return;
    }
    console.log(`[domain] auto-demoted ${domain} to mx_broken (no MX records found)`);
  } catch (e: any) { console.log(`[domain] mx_broken patch err for ${domain}: ${e?.message?.slice(0, 80)}`); }
}

function envDerived(): string {
  const list = process.env.AGENT_EMAIL_DOMAINS?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  if (list.length) return list[Math.floor(Math.random() * list.length)];
  return process.env.AGENT_DOMAIN ?? 'wisentmedia.com';
}

function supabaseEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !key) return null;
  return { url, key };
}

const MAX_SIGNUPS_PER_DOMAIN = 999; // Temporarily raised for domain limit testing
const DOMAIN_PICK_LIMIT = 20;
const PLATFORM_MAX_SIGNUPS: Record<string, number> = {
  // Verified 2026-05-01: TikTok returns register_verify_login error_code=1340
  // after successful email-code verification on domains at 500+ confirmed
  // signups. Do not keep burning attempts on those domains.
  tiktok: Number(process.env.TIKTOK_MAX_SIGNUPS_PER_DOMAIN ?? 500),
};

type DomainRow = {
  domain: string;
  signup_count: number;
  metadata?: Record<string, any> | null;
};

function platformBlock(row: DomainRow, platform?: string): { blocked: boolean; reason?: string } {
  if (!platform) return { blocked: false };
  const p = platform.toLowerCase();
  const md = row.metadata ?? {};
  const block = md.platform_blocks?.[p] ?? md.blocked_platforms?.[p];
  if (!block) {
    const legacyReason = typeof md.last_block_reason === 'string' ? md.last_block_reason : '';
    if (legacyReason.toLowerCase().includes(p)) return { blocked: true, reason: legacyReason };
    return { blocked: false };
  }
  return {
    blocked: true,
    reason: typeof block === 'string' ? block : block.reason,
  };
}

async function pickFromDb(platform?: string): Promise<string | null> {
  const sb = supabaseEnv();
  if (!sb) return null;
  recheckMxBroken(sb);
  const maxSignups = platform ? (PLATFORM_MAX_SIGNUPS[platform.toLowerCase()] ?? MAX_SIGNUPS_PER_DOMAIN) : MAX_SIGNUPS_PER_DOMAIN;
  try {
    // Only pick domains under the signup cap
    const res = await fetch(
      `${sb.url}/rest/v1/inbound_email_domains?status=eq.active&signup_count=lt.${maxSignups}&order=signup_count.asc,last_used_at.asc.nullsfirst&limit=${DOMAIN_PICK_LIMIT}&select=domain,signup_count,metadata`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as DomainRow[];
    if (!rows.length) {
      console.log(`[domain] All active domains have reached ${maxSignups} signups for ${platform ?? 'generic'} — need domain provisioning`);
      if (platform) throw new Error(`domain_unavailable: no active inbound domains below ${maxSignups} signups for ${platform}`);
      return null;
    }
    let row: DomainRow | undefined;
    for (const r of rows) {
      const block = platformBlock(r, platform);
      if (block.blocked) {
        console.log(`[domain] Skipping ${r.domain} for ${platform}: ${block.reason ?? 'platform_blocked'}`);
        continue;
      }
      if (!(await hasValidMx(r.domain))) {
        console.log(`[domain] Skipping ${r.domain} — no MX records; demoting to mx_broken`);
        await markMxBroken(sb, r.domain);
        continue;
      }
      row = r;
      break;
    }
    if (!row) {
      throw new Error(`domain_unavailable: no active inbound domains available for ${platform ?? 'generic'} after platform block + MX filters`);
    }
    console.log(`[domain] Picked ${row.domain} (${row.signup_count}/${maxSignups} confirmed signups so far — not counted yet)`);
    // Bump last_used_at on PICK (not signup_count) so the ORDER BY
    // signup_count.asc,last_used_at.asc rotates to a different domain on
    // the next call, even when no signup PASSes. signup_count still
    // increments only via markSignupSuccess(). Pre-2026-05-12: failed
    // attempts left last_used_at stale, so pickFromDb returned the same
    // domain for every retry in a burst (verified in batch_deep run.log:
    // 10 consecutive register attempts all used @inboxmail659.com).
    try {
      await fetch(
        `${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(row.domain)}`,
        {
          method: 'PATCH',
          headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ last_used_at: new Date().toISOString() }),
        },
      );
    } catch (e: any) { console.log(`[domain] last_used_at patch err: ${e?.message?.slice(0, 80)}`); }
    return row.domain;
  } catch (e: any) {
    if (String(e?.message ?? '').startsWith('domain_unavailable:')) throw e;
    return null;
  }
}

/** Return a domain for use in a new signup email address. */
export async function pickDomain(platform?: string): Promise<string> {
  return (await pickFromDb(platform)) ?? envDerived();
}

/**
 * Increment signup_count + set last_used_at for a domain. Call ONLY after
 * a signup has actually succeeded (account confirmed on the target platform).
 * Accepts a domain string or an email; the part after @ is used.
 */
export async function markSignupSuccess(emailOrDomain: string, platform?: string): Promise<void> {
  const domain = emailOrDomain.includes('@') ? emailOrDomain.split('@')[1] : emailOrDomain;
  const sb = supabaseEnv();
  if (!sb) return;
  try {
    const cur = await fetch(
      `${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(domain)}&select=signup_count,metadata`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!cur.ok) return;
    const rows = (await cur.json()) as Array<{ signup_count: number; metadata?: Record<string, unknown> | null }>;
    const count = rows[0]?.signup_count ?? 0;
    const existingMetadata = (rows[0] as any)?.metadata ?? {};
    const platformSuccess = platform
      ? { ...(existingMetadata.platform_success ?? {}), [platform.toLowerCase()]: new Date().toISOString() }
      : existingMetadata.platform_success;
    await fetch(`${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        last_used_at: new Date().toISOString(),
        signup_count: count + 1,
        metadata: platform ? { ...existingMetadata, platform_success: platformSuccess } : undefined,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {}
}

/** Mark a domain as recently blocked (e.g. TikTok silently stopped sending). */
export async function reportBlocked(domainOrEmail: string, reason?: string, platform?: string): Promise<void> {
  const domain = domainOrEmail.includes('@') ? domainOrEmail.split('@')[1] : domainOrEmail;
  const sb = supabaseEnv();
  if (!sb) return;
  try {
    const existing = await fetch(
      `${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(domain)}&select=block_count,metadata`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!existing.ok) return;
    const rows = (await existing.json()) as Array<{ block_count: number; metadata: Record<string, unknown> }>;
    const cur = rows[0] ?? { block_count: 0, metadata: {} };
    const metadata = cur.metadata ?? {};
    const platformKey = platform?.toLowerCase();
    const platformBlocks = platformKey
      ? {
          ...((metadata as any).platform_blocks ?? {}),
          [platformKey]: { reason: reason ?? 'unspecified', at: new Date().toISOString() },
        }
      : (metadata as any).platform_blocks;
    await fetch(`${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        block_count: cur.block_count + 1,
        last_block_at: new Date().toISOString(),
        metadata: {
          ...metadata,
          last_block_reason: reason ?? 'unspecified',
          ...(platformKey ? { platform_blocks: platformBlocks } : {}),
        },
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {}
}
