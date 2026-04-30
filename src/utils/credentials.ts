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
  if (accountId) {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/social_accounts?id=eq.${accountId}&platform=eq.${platform}&select=id,platform,username,metadata&limit=1`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
    );
    if (!res.ok) return null;
    const rows = await res.json() as SocialAccount[];
    return rows[0] ?? null;
  }
  // Pick the most recently created active account whose cookies aren't known to
  // be stale within the last 24h. The cookies_stale_at field is set by the
  // action runner when a trajectory lands on a platform login wall — so subsequent
  // routine ticks skip the dead account and pick a different one. After 24h
  // we re-try (in case the human refreshed cookies out-of-band).
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&or=(metadata->>cookies_stale_at.is.null,metadata->>cookies_stale_at.lt.${cutoff})&select=id,platform,username,metadata&order=created_at.desc&limit=1`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json() as SocialAccount[];
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
    const since = new Date(Date.now() - 3600_000).toISOString();
    const recent = await fetch(`${supabaseUrl}/rest/v1/account_action_logs?account_id=eq.${accountId}&action=eq.${plat}_login&scheduled_at=gte.${since}&select=id&limit=1`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }).then(r => r.ok ? r.json() : []).catch(() => []);
    if (Array.isArray(recent) && recent.length === 0) await fetch(`${supabaseUrl}/rest/v1/account_action_logs`, { method: 'POST', headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ account_id: accountId, platform: plat, action: `${plat}_login`, status: 'queued', params: { reason: 'auto-recovery from cookies-stale' }, scheduled_at: new Date().toISOString() }) });
  } catch { /* noop */ }
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
import { refreshStickyIfDead } from '../proxy/sticky.js';

export interface AccountSession { proxyUrl?: string; persona?: Persona; }

export async function resolveAccountSession(acct: SocialAccount): Promise<AccountSession> {
  const meta = acct.metadata as any;
  const out: AccountSession = {};
  let cfg: ProxyConfig | null = null;

  // Direct egress for platforms with NO datacenter blacklist. GitHub and
  // Producthunt accept VM IP. LinkedIn HEAD 200 from VM but actual load
  // triggers PerimeterX immediately on datacenter — reverted 2026-04-26.
  // Reddit/Twitter/Instagram/Discord/TikTok all 403 from datacenter.
  const DIRECT_EGRESS_OK = new Set(['github', 'producthunt']);
  if (DIRECT_EGRESS_OK.has(acct.platform) && process.env.WELES_FORCE_PROXY !== '1') {
    if (meta?.persona) out.persona = meta.persona as Persona;
    return out;
  }

  if (meta?.proxy?.host && meta?.proxy?.port && !(await isBurned(meta.proxy.host))) {
    // Reject stored proxies whose hostname doesn't match a known residential
    // provider AND whose username matches the legacy `lbartoszcze` weles relay
    // pattern. Verified 2026-04-29 with brendawatsica187648: stored proxy
    // 209.38.175.3:31112 (Digital Ocean datacenter, decommissioned weles
    // relay) made TikTok serve a stripped-down page (no <button> elements
    // rendered, page size 537 bytes). With dynamic provider selection
    // (BrightData residential), the same trajectory rendered the full page
    // and found the follow button. Same account, same session, same persona
    // — only the proxy changed.
    const { providerFromHost } = await import('../proxy/policy.js');
    const storedProvider = providerFromHost(meta.proxy.host as string, meta.proxy.username as string);
    const isLegacyRelay = !storedProvider && (meta.proxy.username === 'lbartoszcze' || /^209\.38\./.test(meta.proxy.host as string));
    // Capability gate on the stored provider: if the matrix has marked
    // (storedProvider, action) as 'fail', drop the stored proxy and let the
    // dynamic-pick path below find a passing one. Otherwise keep the stored
    // sticky session so accounts maintain a stable exit-IP cohort.
    let storedFailing = false;
    if (storedProvider && process.env.ACTION) {
      try {
        const { isCellFail } = await import('../proxy/capability.js');
        storedFailing = await isCellFail(storedProvider, process.env.ACTION);
      } catch { /* capability lookup best-effort */ }
    }
    if (isLegacyRelay) {
      console.log(`[identity] dropping stored legacy/datacenter proxy ${meta.proxy.host}:${meta.proxy.port} — falling through to provider selection`);
    } else if (storedFailing) {
      console.log(`[identity] capability matrix marks ${storedProvider}/${process.env.ACTION} as fail — dropping stored proxy`);
    } else {
      const refreshed = await refreshStickyIfDead(meta.proxy as ProxyConfig);
      if (refreshed) { cfg = refreshed; if (refreshed !== meta.proxy) await backfillProxy(acct, refreshed); }
    }
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
    // Capability-driven selection: pick the cheapest provider whose matrix
    // cell for this (provider, action) is 'pass' (or 'unknown' on cold-start).
    // The matrix updates after every action via worker/poll.recordOutcome.
    // Self-heals when a provider's quality drops; no hardcoded toxicity table.
    const action = process.env.ACTION ?? `${acct.platform}_unknown`;
    const country = acct.platform === 'discord' ? '' : 'us';
    const PHOST: Record<string, string> = { twitter: 'x.com', linkedin: 'www.linkedin.com', instagram: 'www.instagram.com', reddit: 'www.reddit.com', tiktok: 'www.tiktok.com', discord: 'discord.com', github: 'github.com', producthunt: 'www.producthunt.com' };
    const targetHost = PHOST[acct.platform];
    try {
      const { selectByCapability } = await import('../proxy/capability.js');
      const mod = await import('../proxy/config.js');
      // Walk down the cost-ordered list of passing providers. If the cheapest
      // one's resolveProxy fails (sticky preflight, no live IPs), exclude it
      // and try the next. Caps at 5 attempts so we never spin forever.
      const tried: string[] = [];
      let pw: Awaited<ReturnType<typeof mod.resolveProxy>> | undefined;
      for (let i = 0; i < 5; i++) {
        const winner = await selectByCapability(action, tried);
        if (!winner) {
          console.log(`[identity] no provider passes capability for action=${action} platform=${acct.platform}`);
          break;
        }
        const filter = `residential ${winner.provider} ${country}`.trim();
        pw = await mod.resolveProxy(filter, targetHost);
        if (pw) {
          console.log(`[identity] capability pick ${winner.provider} ($${winner.cost_per_gb}/GB) for action=${action}`);
          break;
        }
        tried.push(winner.provider);
      }
      // Mobile carrier IPs as last resort — rarely on platform blocklists.
      if (!pw) pw = await mod.resolveProxy(`mobile ${country}`.trim(), targetHost) ?? await mod.resolveProxy('mobile', targetHost);
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
