// Non-secret service metadata remains in Weles DB; all login and API secret
// material resolves only through exact scoped Skarbiec contracts.
import {
  readOptionalWelesServiceLogin,
  readOptionalWelesServiceSecret,
  type WelesServiceSecret,
} from '../secrets/scoped-service.js';
import { optionalWelesDatabase } from './weles-database.js';
interface ServiceCredential {
  display_name: string;
  category: string;
  proxy_host: string | null;
  proxy_port: string | null;
  api_key_env_var: string | null;
  balance_usd: number | null;
  notes: string | null;
}

let _cache: ServiceCredential[] | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

async function fetchAll(): Promise<ServiceCredential[]> {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;
  const database = optionalWelesDatabase();
  if (!database) {
    console.log('[credentials] No weles-database launcher configuration');
    return [];
  }
  const databaseUrl = database.url;
  const databaseToken = database.token;
  const res = await fetch(
    `${databaseUrl}/rest/v1/service_credentials?select=display_name,category,proxy_host,proxy_port,api_key_env_var,balance_usd,notes`,
    { headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}` } },
  );
  if (!res.ok) { console.log(`[credentials] Fetch failed: ${res.status}`); return []; }
  _cache = await res.json() as ServiceCredential[];
  _cacheTime = Date.now();
  return _cache;
}

export async function getByCategory(category: string): Promise<ServiceCredential[]> {
  return (await fetchAll()).filter(c => c.category === category);
}

export async function getCaptchaCredentials(): Promise<{ anticaptcha?: string; twocaptcha?: string; capsolver?: string; capmonster?: string; nocaptcha?: string; nopecha?: string }> {
  const credentials = {
    anticaptcha: readOptionalWelesServiceSecret('antiCaptcha', 'api_key'),
    twocaptcha: readOptionalWelesServiceSecret('twoCaptcha', 'api_key'),
    capsolver: readOptionalWelesServiceSecret('capsolver', 'api_key'),
    capmonster: readOptionalWelesServiceSecret('capmonster', 'api_key'),
    nocaptcha: readOptionalWelesServiceSecret('noCaptcha', 'api_key'),
    nopecha: readOptionalWelesServiceSecret('nopecha', 'api_key'),
  };
  console.log(`[credentials] Captcha services: ${Object.entries(credentials).filter(([, value]) => value).map(([name]) => name).join(', ') || 'none'}`);
  return credentials;
}

export async function getEmailApiKey(): Promise<string | undefined> {
  return readOptionalWelesServiceSecret('resendReceiving', 'api_key');
}

interface SocialAccount {
  id?: string;
  platform: string;
  username: string;
  metadata: { email?: string; password?: string; skarbiec_credential_id?: string; cookies?: unknown[]; status?: string; proxy?: unknown };
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
  const databaseUrl = optionalWelesDatabase()?.url ?? '';
  const databaseToken = optionalWelesDatabase()?.token ?? '';
  if (!databaseUrl || !databaseToken) return null;
  const accountId = process.env.ACCOUNT_ID;
  if (accountId) {
    // is_active=true so ACCOUNT_ID rows for deactivated accounts (queued
    // pre-deactivation) bail immediately rather than running pointlessly.
    const res = await fetch(
      `${databaseUrl}/rest/v1/social_accounts?id=eq.${accountId}&platform=eq.${platform}&is_active=eq.true&select=id,platform,username,metadata&limit=1`,
      { headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}` } },
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
    `${databaseUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=10`,
    { headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}` } },
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
    `${databaseUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=1`,
    { headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}` } },
  );
  if (!lastResortRes.ok) return null;
  const lastResortRows = await lastResortRes.json() as SocialAccount[];
  return lastResortRows[0] ?? null;
}

/** Mark cookies stale + auto-enqueue {platform}_login to refresh, except Apple. */
export async function markCookiesStale(accountId: string): Promise<void> {
  if (!accountId) return;
  const databaseUrl = optionalWelesDatabase()?.url ?? '';
  const databaseToken = optionalWelesDatabase()?.token ?? '';
  if (!databaseUrl || !databaseToken) return;
  try {
    const r = await fetch(`${databaseUrl}/rest/v1/social_accounts?id=eq.${accountId}&select=metadata,platform`, { headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}` } });
    if (!r.ok) return;
    const rows = await r.json() as { metadata: Record<string, unknown> | null; platform?: string }[];
    const merged = { ...(rows[0]?.metadata ?? {}), cookies_stale_at: new Date().toISOString() };
    await fetch(`${databaseUrl}/rest/v1/social_accounts?id=eq.${accountId}`, { method: 'PATCH', headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: merged }) });
    const plat = rows[0]?.platform;
    if (!plat) return;
    if (plat.toLowerCase() === 'apple') {
      console.warn('[credentials] OWNER_ACTION_REQUIRED: Apple cookies are stale; apple_login was not auto-enqueued');
      return;
    }
    const flagRes = await fetch(`${databaseUrl}/rest/v1/system_settings?key=eq.workers_enabled&select=value`, { headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}` } });
    if (flagRes.ok) {
      const flagRows = await flagRes.json() as Array<{ value?: { enabled?: boolean } }>;
      if (flagRows[0]?.value?.enabled === false) return;
    }
    const since = new Date(Date.now() - 3600_000).toISOString();
    const recent = await fetch(`${databaseUrl}/rest/v1/account_action_logs?account_id=eq.${accountId}&action=eq.${plat}_login&scheduled_at=gte.${since}&select=id&limit=1`, { headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}` } }).then(r => r.ok ? r.json() : []).catch(() => []);
    if (Array.isArray(recent) && recent.length === 0) await fetch(`${databaseUrl}/rest/v1/account_action_logs`, { method: 'POST', headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ account_id: accountId, platform: plat, action: `${plat}_login`, status: 'queued', params: { reason: 'auto-recovery from cookies-stale' }, scheduled_at: new Date().toISOString() }) });
  } catch { /* noop */ }
}

type ServiceLoginContract = {
  service: WelesServiceSecret;
  loginMethod: 'email_password' | 'google_sso';
};

const SERVICE_LOGIN_CONTRACTS: Readonly<Record<string, ServiceLoginContract>> = Object.freeze({
  'bright data': { service: 'brightdataDashboard', loginMethod: 'google_sso' },
  umami: { service: 'umamiDashboard', loginMethod: 'email_password' },
  'google analytics': { service: 'googleSso', loginMethod: 'google_sso' },
  claude: { service: 'googleSso', loginMethod: 'google_sso' },
  codex: { service: 'googleSso', loginMethod: 'google_sso' },
  linear: { service: 'linearDashboard', loginMethod: 'email_password' },
  supabase: { service: 'supabaseDashboard', loginMethod: 'email_password' },
  oxylabs: { service: 'oxylabsDashboard', loginMethod: 'google_sso' },
  vast: { service: 'vastDashboard', loginMethod: 'email_password' },
  'vast.ai': { service: 'vastDashboard', loginMethod: 'email_password' },
});

export async function getServiceLogin(displayName: string): Promise<{ email: string; password: string; loginMethod: string } | null> {
  const contract = SERVICE_LOGIN_CONTRACTS[displayName.trim().toLowerCase()];
  if (!contract) return null;
  const login = readOptionalWelesServiceLogin(contract.service);
  return login ? { email: login.email, password: login.password, loginMethod: contract.loginMethod } : null;
}

const PLATFORM_ADMIN_LOGIN_CONTRACTS: Readonly<Record<string, WelesServiceSecret>> = Object.freeze({
  'platform-admin-google': 'googleWorkspaceAdmin',
  'platform-admin-linear': 'linearDashboard',
  'platform-admin-sso': 'googleWorkspaceAdmin',
});

// Readiness is based only on an exact item+consumer+field grant. Unknown
// platform IDs fail closed instead of probing plaintext Weles DB columns.
export async function platformAdminSessionReady(credentialId: string): Promise<{ ready: boolean; source: string }> {
  const service = PLATFORM_ADMIN_LOGIN_CONTRACTS[credentialId];
  if (!service) return { ready: false, source: 'no_exact_skarbiec_contract' };
  try {
    const login = readOptionalWelesServiceLogin(service);
    return login
      ? { ready: true, source: `skarbiec:${service}` }
      : { ready: false, source: `skarbiec_grant_unavailable:${service}` };
  } catch {
    return { ready: false, source: `skarbiec_error:${service}` };
  }
}

export type { ServiceCredential, SocialAccount };

// resolveAccountSession + AccountSession moved to src/account/session.ts on
// 2026-05-03 (file-size cap). Re-exported here so callers using the legacy
// `import { resolveAccountSession } from '../utils/credentials.js'` still work.
export { resolveAccountSession } from '../account/session.js';
export type { AccountSession } from '../account/session.js';
