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
  platform: string;
  username: string;
  metadata: { email?: string; password?: string; cookies?: any[]; status?: string };
}

/** Get an active social account for a platform from the social_accounts table. */
export async function getSocialAccount(platform: string): Promise<SocialAccount | null> {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return null;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=platform,username,metadata&order=created_at.desc&limit=1`,
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
