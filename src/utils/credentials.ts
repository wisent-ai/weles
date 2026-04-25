/**
 * Fetch service credentials from the service_credentials Supabase table.
 * Used by proxy, captcha, and email modules instead of hardcoded env var names.
 */

interface ServiceCredential {
  display_name: string;
  category: string;
  proxy_host: string | null;
  proxy_port: string | null;
  api_key_env_var: string | null;
  api_key_preview: string | null;
  balance_usd: number | null;
  notes: string | null;
}

let _cache: ServiceCredential[] | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

async function fetchAll(): Promise<ServiceCredential[]> {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) { console.log('[credentials] No Supabase credentials'); return []; }
  const res = await fetch(
    `${supabaseUrl}/rest/v1/service_credentials?select=display_name,category,proxy_host,proxy_port,api_key_env_var,api_key_preview,balance_usd,notes`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) { console.log(`[credentials] Fetch failed: ${res.status}`); return []; }
  _cache = await res.json() as ServiceCredential[];
  _cacheTime = Date.now();
  return _cache;
}

export async function getByCategory(category: string): Promise<ServiceCredential[]> {
  return (await fetchAll()).filter(c => c.category === category);
}

export async function getCaptchaCredentials(): Promise<{ anticaptcha?: string; twocaptcha?: string; capsolver?: string; capmonster?: string }> {
  const creds: Record<string, string | undefined> = {};
  for (const s of await getByCategory('captcha')) {
    if (!s.api_key_env_var || s.balance_usd === null || s.balance_usd <= 0) continue;
    const key = process.env[s.api_key_env_var];
    if (!key) continue;
    const name = s.display_name.toLowerCase();
    if (name.includes('anticaptcha') || name.includes('anti-captcha')) creds.anticaptcha = key;
    else if (name.includes('2captcha')) creds.twocaptcha = key;
    else if (name.includes('capsolver')) creds.capsolver = key;
    else if (name.includes('capmonster')) creds.capmonster = key;
  }
  console.log(`[credentials] Captcha services: ${Object.keys(creds).join(', ') || 'none'}`);
  return creds;
}

export async function getEmailApiKey(): Promise<string | undefined> {
  return process.env.RESEND_RECEIVING_API_KEY ?? undefined;
}

interface SocialAccount {
  id?: string;
  platform: string;
  username: string;
  metadata: { email?: string; password?: string; cookies?: any[]; status?: string; proxy?: any };
}

/**
 * Get an active social account for a platform from the social_accounts table.
 *
 * When the worker spawns a trajectory it sets ACCOUNT_ID in env — that is the
 * specific account the scheduler's claim landed on. Honor it so the trajectory
 * acts on the queued-for account, not whatever `latest active` returns. Falls
 * back to "most recent active" when ACCOUNT_ID is absent (manual invocations).
 */
export async function getSocialAccount(platform: string): Promise<SocialAccount | null> {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return null;
  const accountId = process.env.ACCOUNT_ID;
  const query = accountId
    ? `id=eq.${accountId}&platform=eq.${platform}&select=id,platform,username,metadata&limit=1`
    : `platform=eq.${platform}&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=1`;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?${query}`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json() as SocialAccount[];
  return rows[0] ?? null;
}

/** Get service credentials for balance checks (login_email + login_password from DB). */
export async function getServiceLogin(displayName: string): Promise<{ email: string; password: string } | null> {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return null;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/service_credentials?display_name=ilike.${encodeURIComponent(displayName)}&select=login_email,login_password&limit=1`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json() as { login_email: string | null; login_password: string | null }[];
  const row = rows[0];
  if (!row?.login_email || !row?.login_password) return null;
  return { email: row.login_email, password: row.login_password };
}

export type { ServiceCredential, SocialAccount };

// --- Per-account session identity: restore proxy + persona so register and
// login look like the same device. Reuses ProxyConfig/proxyUrl from the shared
// src/proxy/config.ts module (matching schema the Python signup side writes to
// social_accounts.metadata.proxy). If the account has no persona yet (pre-V1
// rows), generate one keyed to the stored proxy country and backfill metadata.
import type { Persona } from '../browser/persona.js';
import { generatePersona } from '../browser/persona.js';
import { proxyUrl as buildProxyUrl, type ProxyConfig } from '../proxy/config.js';
import { isBurned } from '../proxy/burned.js';

export interface AccountSession { proxyUrl?: string; persona?: Persona; }

export async function resolveAccountSession(acct: SocialAccount): Promise<AccountSession> {
  const meta = acct.metadata as any;
  const out: AccountSession = {};
  let cfg: ProxyConfig | null = null;

  if (meta?.proxy?.host && meta?.proxy?.port && !(await isBurned(meta.proxy.host))) {
    cfg = meta.proxy as ProxyConfig;
  } else if (meta?.proxy?.server) {
    // Legacy shape from the old Python signup path: { server, username, password }.
    // Convert in place — parsed URL gives host/port/protocol.
    try {
      const u = new URL(meta.proxy.server as string);
      cfg = {
        host: u.hostname,
        port: Number(u.port),
        protocol: u.protocol.replace(/:$/, ''),
        username: meta.proxy.username,
        password: meta.proxy.password,
      };
      await backfillProxy(acct, cfg);
    } catch { /* bad server url, fall through */ }
  }

  if (!cfg && process.env.PROXY_URL) {
    out.proxyUrl = process.env.PROXY_URL;
  } else if (!cfg) {
    // No stored proxy at all. Pick a provider deterministically from the
    // account id so the fleet spreads across providers instead of every
    // account exiting through the same Oxylabs BR /16. Same id always hashes
    // to the same provider — keeps the account's exit-IP cohort stable.
    const PROVIDERS = ['oxylabs', 'packetstream', 'pingproxies'];
    let hash = 0;
    for (const ch of (acct.id ?? acct.username ?? '')) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    const provider = PROVIDERS[Math.abs(hash) % PROVIDERS.length];
    try {
      const mod = await import('../proxy/config.js');
      const pw = await mod.resolveProxy(`residential ${provider}`) ?? await mod.resolveProxy('residential');
      if (pw?.server) {
        const u = new URL(pw.server);
        cfg = {
          host: u.hostname,
          port: Number(u.port),
          protocol: u.protocol.replace(/:$/, ''),
          username: pw.username,
          password: pw.password,
          country: pw.country,
        };
        await backfillProxy(acct, cfg);
      }
    } catch (e) {
      console.error('[identity] dynamic proxy assignment failed:', (e as Error).message);
    }
  }

  if (cfg) out.proxyUrl = buildProxyUrl(cfg);
  if (meta?.persona) {
    out.persona = meta.persona as Persona;
  } else {
    out.persona = generatePersona({ country: cfg?.country ?? meta?.proxy?.country });
    await backfillPersona(acct, out.persona);
  }
  return out;
}

async function backfillProxy(acct: SocialAccount, cfg: ProxyConfig): Promise<void> {
  if (!acct.id) return;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return;
  const merged = { ...((acct.metadata ?? {}) as any), proxy: cfg };
  try {
    await fetch(`${url}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: merged }),
    });
  } catch (e) {
    console.error('[identity] backfillProxy failed:', (e as Error).message);
  }
}

async function backfillPersona(acct: SocialAccount, persona: Persona): Promise<void> {
  if (!acct.id) return;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return;
  // Supabase PATCH on a JSONB column replaces the whole value, so merge in Node.
  const merged = { ...((acct.metadata ?? {}) as any), persona };
  try {
    await fetch(`${url}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: merged }),
    });
  } catch (e) {
    console.error('[identity] backfillPersona failed:', (e as Error).message);
  }
}
