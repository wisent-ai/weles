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

const MAX_SIGNUPS_PER_DOMAIN = 10;

async function pickFromDb(): Promise<string | null> {
  const sb = supabaseEnv();
  if (!sb) return null;
  try {
    // Only pick domains under the signup cap
    const res = await fetch(
      `${sb.url}/rest/v1/inbound_email_domains?status=eq.active&signup_count=lt.${MAX_SIGNUPS_PER_DOMAIN}&order=signup_count.asc,last_used_at.asc.nullsfirst&limit=1&select=domain,signup_count`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ domain: string; signup_count: number }>;
    if (!rows.length) {
      console.log(`[domain] All active domains have reached ${MAX_SIGNUPS_PER_DOMAIN} signups — need manual domain provisioning`);
      return null;
    }
    const row = rows[0];
    console.log(`[domain] Picked ${row.domain} (${row.signup_count}/${MAX_SIGNUPS_PER_DOMAIN} confirmed signups so far — not counted yet)`);
    // Do NOT bump signup_count here. It only increments on confirmed-successful
    // account creation via markSignupSuccess(). Previously failed attempts
    // inflated the counter and auto-provisioned junk domains.
    return row.domain;
  } catch {
    return null;
  }
}

/** Return a domain for use in a new signup email address. */
export async function pickDomain(): Promise<string> {
  return (await pickFromDb()) ?? envDerived();
}

/**
 * Increment signup_count + set last_used_at for a domain. Call ONLY after
 * a signup has actually succeeded (account confirmed on the target platform).
 * Accepts a domain string or an email; the part after @ is used.
 */
export async function markSignupSuccess(emailOrDomain: string): Promise<void> {
  const domain = emailOrDomain.includes('@') ? emailOrDomain.split('@')[1] : emailOrDomain;
  const sb = supabaseEnv();
  if (!sb) return;
  try {
    const cur = await fetch(
      `${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(domain)}&select=signup_count`,
      { headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}` } },
    );
    if (!cur.ok) return;
    const rows = (await cur.json()) as Array<{ signup_count: number }>;
    const count = rows[0]?.signup_count ?? 0;
    await fetch(`${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ last_used_at: new Date().toISOString(), signup_count: count + 1, updated_at: new Date().toISOString() }),
    });
  } catch {}
}

/** Mark a domain as recently blocked (e.g. TikTok silently stopped sending). */
export async function reportBlocked(domain: string, reason?: string): Promise<void> {
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
    await fetch(`${sb.url}/rest/v1/inbound_email_domains?domain=eq.${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      headers: { apikey: sb.key, Authorization: `Bearer ${sb.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        block_count: cur.block_count + 1,
        last_block_at: new Date().toISOString(),
        metadata: { ...cur.metadata, last_block_reason: reason ?? 'unspecified' },
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {}
}
