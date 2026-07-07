// Fetch service credentials from service_credentials. Used by proxy/captcha/email modules.
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

export async function getCaptchaCredentials(): Promise<{ anticaptcha?: string; twocaptcha?: string; capsolver?: string; capmonster?: string; nopecha?: string }> {
  const creds: Record<string, string | undefined> = {};
  for (const s of await getByCategory('captcha')) {
    if (!s.api_key_env_var) continue;
    const key = process.env[s.api_key_env_var];
    if (!key) continue;
    const name = s.display_name.toLowerCase();
    if (name.includes('anticaptcha') || name.includes('anti-captcha')) creds.anticaptcha = key;
    else if (name.includes('2captcha')) creds.twocaptcha = key;
    else if (name.includes('capsolver')) creds.capsolver = key;
    else if (name.includes('capmonster')) creds.capmonster = key;
    else if (name.includes('nopecha')) creds.nopecha = key;
  }
  if (!creds.nopecha && process.env.NOPECHA_API_KEY) creds.nopecha = process.env.NOPECHA_API_KEY;
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
  if (accountId) {
    // is_active=true so ACCOUNT_ID rows for deactivated accounts (queued
    // pre-deactivation) bail immediately rather than running pointlessly.
    const res = await fetch(
      `${supabaseUrl}/rest/v1/social_accounts?id=eq.${accountId}&platform=eq.${platform}&is_active=eq.true&select=id,platform,username,metadata&limit=1`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
    );
    if (!res.ok) return null;
    const rows = await res.json() as SocialAccount[];
    return rows[0] ?? null;
  }
  // Skip accounts cookies-stale within 24h, unless a newer cookies_minted_at
  // shows a successful re-login already happened. PostgREST can't compare two
  // columns within a row, so fetch top N candidates and filter in JS.
  const cutoffMs = Date.now() - 24 * 3600 * 1000;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=10`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return null;
  const rowsAll = await res.json() as SocialAccount[];
  const rows = rowsAll.filter((r) => {
    const m = (r as any).metadata ?? {};
    const staleMs = Date.parse(m.cookies_stale_at ?? '');
    const mintMs = Date.parse(m.cookies_minted_at ?? '');
    if (!Number.isFinite(staleMs)) return true;
    if (staleMs < cutoffMs) return true;
    if (Number.isFinite(mintMs) && mintMs >= staleMs) return true;
    return false;
  });
  if (rows[0]) return rows[0];
  // Last-resort: no fresh account exists for this platform. Use the most-recent
  // one even if marked stale, so the trajectory at least runs and surfaces a
  // useful checkpoint signal (rather than failing at "no active account").
  const lastResortRes = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=1`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!lastResortRes.ok) return null;
  const lastResortRows = await lastResortRes.json() as SocialAccount[];
  return lastResortRows[0] ?? null;
}

/** Mark cookies stale + auto-enqueue {platform}_login to refresh. */
export async function markCookiesStale(accountId: string): Promise<void> {
  if (!accountId) return;
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${accountId}&select=metadata,platform`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } });
    if (!r.ok) return;
    const rows = await r.json() as { metadata: Record<string, unknown> | null; platform?: string }[];
    const merged = { ...(rows[0]?.metadata ?? {}), cookies_stale_at: new Date().toISOString() };
    await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${accountId}`, { method: 'PATCH', headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: merged }) });
    const plat = rows[0]?.platform;
    if (!plat) return;
    const flagRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?key=eq.workers_enabled&select=value`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } });
    if (flagRes.ok) {
      const flagRows = await flagRes.json() as Array<{ value?: { enabled?: boolean } }>;
      if (flagRows[0]?.value?.enabled === false) return;
    }
    const since = new Date(Date.now() - 3600_000).toISOString();
    const recent = await fetch(`${supabaseUrl}/rest/v1/account_action_logs?account_id=eq.${accountId}&action=eq.${plat}_login&scheduled_at=gte.${since}&select=id&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }).then(r => r.ok ? r.json() : []).catch(() => []);
    if (Array.isArray(recent) && recent.length === 0) await fetch(`${supabaseUrl}/rest/v1/account_action_logs`, { method: 'POST', headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ account_id: accountId, platform: plat, action: `${plat}_login`, status: 'queued', params: { reason: 'auto-recovery from cookies-stale' }, scheduled_at: new Date().toISOString() }) });
  } catch { /* noop */ }
}

/** Get service credentials for balance checks (login_email + login_password from DB). */
export async function getServiceLogin(displayName: string): Promise<{ email: string; password: string; loginMethod: string; totpSecret?: string } | null> {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return null;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/service_credentials?display_name=ilike.${encodeURIComponent(displayName)}&select=login_email,login_password,login_method,metadata&limit=1`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json() as { login_email: string | null; login_password: string | null; login_method: string | null; metadata: Record<string, unknown> | null }[];
  const [row] = rows;
  if (!row?.login_email || !row?.login_password) return null;
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata as { google_totp_secret?: unknown } : null;
  const totpSecret = meta && typeof meta.google_totp_secret === 'string' ? meta.google_totp_secret : undefined;
  return { email: row.login_email, password: row.login_password, loginMethod: row.login_method ?? 'email_password', totpSecret };
}

export type { ServiceCredential, SocialAccount };

// resolveAccountSession + AccountSession moved to src/account/session.ts on
// 2026-05-03 (file-size cap). Re-exported here so callers using the legacy
// `import { resolveAccountSession } from '../utils/credentials.js'` still work.
export { resolveAccountSession } from '../account/session.js';
export type { AccountSession } from '../account/session.js';
