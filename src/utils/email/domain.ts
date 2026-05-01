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
 */

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
    const row = rows.find(r => {
      const block = platformBlock(r, platform);
      if (block.blocked) {
        console.log(`[domain] Skipping ${r.domain} for ${platform}: ${block.reason ?? 'platform_blocked'}`);
        return false;
      }
      return true;
    });
    if (!row) {
      throw new Error(`domain_unavailable: no active inbound domains available for ${platform ?? 'generic'} after platform block filters`);
    }
    console.log(`[domain] Picked ${row.domain} (${row.signup_count}/${maxSignups} confirmed signups so far — not counted yet)`);
    // Do NOT bump signup_count here. It only increments on confirmed-successful
    // account creation via markSignupSuccess(). Previously failed attempts
    // inflated the counter and auto-provisioned junk domains.
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
