// Per-account session identity: restore proxy + persona so register and
// login look like the same device. Reuses ProxyConfig/proxyUrl from the shared
// src/proxy/config.ts module (matching schema the Python signup side writes to
// social_accounts.metadata.proxy). If the account has no persona yet (pre-V1
// rows), generate one keyed to the stored proxy country and backfill metadata.
//
// Extracted from src/utils/credentials.ts on 2026-05-03; that file crossed
// the 300-line cap. credentials.ts re-exports resolveAccountSession +
// AccountSession for backwards-compat with all existing callers.

import type { Persona } from '../browser/persona.js';
import { generatePersona } from '../browser/persona.js';
import { hydratePinnedProxy, proxyUrl as buildProxyUrl, resolveProxy } from '../proxy/config.js';
import type { ProxyConfig, ResolvedProxy } from '../proxy/config.js';
import { isBurned } from '../proxy/burned.js';
import { selectByCapability, taskNetworkRequirements } from '../proxy/capability.js';
import { refreshStickyIfDead } from '../proxy/sticky.js';
import type { SocialAccount } from '../utils/credentials.js';
import { optionalWelesDatabase } from '../utils/weles-database.js';

export interface AccountSession { proxyUrl?: string; persona?: Persona; }

const PLATFORM_HOSTS: Record<string, string> = {
  twitter: 'x.com',
  linkedin: 'www.linkedin.com',
  instagram: 'www.instagram.com',
  reddit: 'www.reddit.com',
  tiktok: 'www.tiktok.com',
  discord: 'discord.com',
  github: 'github.com',
  producthunt: 'www.producthunt.com',
  pangram: 'www.pangram.com',
};

function inferTrajectoryAction(platform: string): string {
  const explicit = process.env.ACTION?.trim();
  if (explicit) return explicit;

  const script = process.argv[1] ?? '';
  const parts = script.replace(/\.(?:mjs|cjs|js|ts)$/, '').split(/[\\/]+/).filter(Boolean);
  const file = parts[parts.length - 1] ?? '';
  const parent = parts[parts.length - 2] ?? '';
  const grandparent = parts[parts.length - 3] ?? '';

  if (file.startsWith(`${platform}_`)) return file;
  if (parent === platform && file && file !== 'index') return `${platform}_${file}`;
  if (grandparent === platform && file && !['index', 'run'].includes(file)) return `${platform}_${file}`;
  if (grandparent === platform && parent && file === 'run') return `${platform}_${parent}`;
  return `${platform}_unknown`;
}

export async function resolveAccountSession(acct: SocialAccount): Promise<AccountSession> {
  const meta = acct.metadata as any;
  const out: AccountSession = {};
  let cfg: ProxyConfig | null = null;
  const action = inferTrajectoryAction(acct.platform);
  const targetHost = PLATFORM_HOSTS[acct.platform];

  const network = taskNetworkRequirements(action, acct.platform);
  const savedProxy = meta?.proxy as (Partial<ProxyConfig> & { server?: string; exit_ip_url?: string }) | undefined;
  const hasSavedProxy = Boolean(savedProxy?.exit_ip_url
    || (savedProxy?.host && savedProxy?.port)
    || savedProxy?.server);

  // Capability-bootstrap force-override: exercise one explicit provider without
  // mutating the account's permanent pin.
  if (process.env.PROXY_URL && process.env.PROXY_URL_FORCE === '1') {
    out.proxyUrl = process.env.PROXY_URL;
    out.persona = (meta?.persona as Persona | undefined) ?? generatePersona({});
    return out;
  }

  if (network.route === 'direct' && !hasSavedProxy && process.env.WELES_FORCE_PROXY !== '1') {
    if (meta?.persona) out.persona = meta.persona as Persona;
    return out;
  }

  const policy = await import('../proxy/policy.js');
  if (savedProxy?.exit_ip_url) {
    try {
      const parsed = new URL(savedProxy.exit_ip_url);
      const provider = savedProxy.provider ?? policy.providerFromHost(parsed.hostname, parsed.username);
      if (!provider) throw new Error('unknown_provider');
      cfg = hydratePinnedProxy({
        host: parsed.hostname,
        port: Number(parsed.port),
        protocol: parsed.protocol.replace(/:$/, ''),
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        country: savedProxy.country,
        provider,
        proxy_type: savedProxy.proxy_type ?? 'isp',
        sticky_session_id: savedProxy.sticky_session_id,
        sticky_hash: savedProxy.sticky_hash,
        city: savedProxy.city,
      }) ?? null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`pinned_proxy_invalid:${action}:${reason}`);
    }
  } else if (savedProxy?.host && savedProxy?.port) {
    const host = savedProxy.host;
    if (await isBurned(host, acct.platform)) throw new Error(`pinned_proxy_burned:${action}:${host}:${savedProxy.port}`);
    const retiredReason = policy.retiredProviderReason(host, savedProxy.port);
    if (retiredReason) {
      console.log(`[identity] retiring account ${acct.username}: stored proxy ${host}:${savedProxy.port} is from a retired pool (${retiredReason})`);
      await burnAccount(acct, `retired_proxy:${retiredReason}`);
      throw new Error(`retired_proxy:${retiredReason}:${host}:${savedProxy.port}`);
    }
    const provider = savedProxy.provider ?? policy.providerFromHost(host, savedProxy.username);
    const isLegacyRelay = !provider && (savedProxy.username === 'lbartoszcze' || host.startsWith('209.38.'));
    if (isLegacyRelay || !provider) {
      await burnAccount(acct, isLegacyRelay ? 'retired_proxy:legacy_relay' : 'retired_proxy:unknown_provider');
      throw new Error(`pinned_proxy_unavailable:${action}:${host}:${savedProxy.port}`);
    }
    try {
      const { isCellFail } = await import('../proxy/capability.js');
      if (await isCellFail(provider, action)) {
        throw new Error(`capability_failed:${provider}:${action}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.startsWith('capability_failed:')) throw error;
    }
    const proxyType = savedProxy.proxy_type
      ?? (provider === 'decodo' || host.toLowerCase().includes('isp') ? 'isp' : 'residential');
    cfg = hydratePinnedProxy({
      ...savedProxy,
      host,
      port: savedProxy.port,
      protocol: savedProxy.protocol ?? 'http',
      provider,
      proxy_type: proxyType,
    }) ?? null;
  } else if (savedProxy?.server) {
    try {
      const parsed = new URL(savedProxy.server);
      const provider = savedProxy.provider ?? policy.providerFromHost(parsed.hostname, savedProxy.username);
      if (!provider) throw new Error('unknown_provider');
      cfg = hydratePinnedProxy({
        host: parsed.hostname,
        port: Number(parsed.port),
        protocol: parsed.protocol.replace(/:$/, ''),
        username: savedProxy.username,
        password: savedProxy.password,
        country: savedProxy.country,
        provider,
        proxy_type: savedProxy.proxy_type,
        sticky_session_id: savedProxy.sticky_session_id,
        sticky_hash: savedProxy.sticky_hash,
        city: savedProxy.city,
      }) ?? null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`pinned_proxy_invalid:${action}:${reason}`);
    }
  }
  if (hasSavedProxy && cfg) {
    const refreshed = await refreshStickyIfDead(cfg, targetHost);
    if (refreshed) {
      cfg = refreshed;
      await backfillProxy(acct, cfg);
    } else {
      const reason = `dead_pinned_proxy:${action}:${cfg.provider ?? 'unknown'}`;
      console.log(`[identity] failing over account ${acct.username}: ${reason}`);
      await clearDeadProxy(acct, reason);
      cfg = null;
    }
  }

  if (!cfg && process.env.PROXY_URL) {
    out.proxyUrl = process.env.PROXY_URL;
  } else if (!cfg && process.env.WELES_ALLOW_DIRECT_ACCOUNT_SESSION === '1') {
    console.log(`[identity] explicit direct account session action=${action} platform=${acct.platform}`);
  } else if (!cfg) {
    const country = network.country ?? '';
    try {
      const tried: string[] = [];
      let pw: ResolvedProxy | undefined;
      for (let i = 0; i < 5; i++) {
        const winner = await selectByCapability(action, tried);
        if (!winner) {
          console.log(`[identity] no provider passes capability for action=${action} platform=${acct.platform}`);
          break;
        }
        const filter = `${network.proxyType ?? 'isp'} ${winner.provider} ${country}`.trim();
        pw = await resolveProxy(filter, targetHost);
        if (pw) {
          console.log(`[identity] capability pick ${winner.provider} ($${winner.cost_per_gb}/GB) route=${network.proxyType ?? 'isp'} action=${action}`);
          break;
        }
        tried.push(winner.provider);
      }
      if (!pw) throw new Error(`proxy_unavailable:${network.proxyType ?? 'isp'}:${action}:${acct.platform}:${country}`);
      if (pw?.server) {
        const u = new URL(pw.server);
        cfg = {
          host: u.hostname,
          port: Number(u.port),
          protocol: u.protocol.replace(/:$/, ''),
          username: pw.username,
          password: pw.password,
          country: pw.country,
          provider: pw.provider,
          proxy_type: pw.proxy_type,
          sticky_session_id: pw.sticky_session_id,
          sticky_hash: pw.sticky_hash,
          city: pw.city,
        };
        await backfillProxy(acct, cfg);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error('[identity] dynamic proxy assignment failed:', reason);
      throw new Error(`proxy_resolution_failed:${action}:${reason}`);
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

async function clearDeadProxy(acct: SocialAccount, reason: string): Promise<void> {
  const metadata = { ...((acct.metadata ?? {}) as Record<string, any>) };
  const previous = metadata.proxy as Partial<ProxyConfig> | undefined;
  delete metadata.proxy;
  metadata.proxy_failover = {
    at: new Date().toISOString(),
    reason,
    previous: previous ? {
      host: previous.host,
      port: previous.port,
      provider: previous.provider,
      proxy_type: previous.proxy_type,
    } : null,
  };
  (acct as any).metadata = metadata;

  if (!acct.id) return;
  const url = optionalWelesDatabase()?.url ?? '';
  const key = optionalWelesDatabase()?.token ?? '';
  if (!url || !key) return;
  try {
    const response = await fetch(`${url}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata }),
    });
    if (!response.ok) console.error(`[identity] clearDeadProxy failed: HTTP ${response.status}`);
  } catch (e) {
    console.error('[identity] clearDeadProxy failed:', (e as Error).message);
  }
}

async function backfillProxy(acct: SocialAccount, cfg: ProxyConfig): Promise<void> {
  if (!acct.id) return;
  const url = optionalWelesDatabase()?.url ?? '';
  const key = optionalWelesDatabase()?.token ?? '';
  if (!url || !key) return;
  // Registration-time endpoints stay pinned until an authenticated CONNECT
  // preflight proves the route is dead and clearDeadProxy records the failover.
  const existingHost = (acct.metadata as any)?.proxy?.host;
  const existingPort = (acct.metadata as any)?.proxy?.port;
  if (existingHost && (existingHost !== cfg.host || existingPort !== cfg.port)) {
    console.log(`[identity] backfillProxy: preserving registration-time proxy ${existingHost}:${existingPort} (refusing overwrite to ${cfg.host}:${cfg.port})`);
    return;
  }
  const pin = { ...cfg };
  delete pin.username;
  delete pin.password;
  const merged = { ...(acct.metadata ?? {}), proxy: pin };
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

// Mark an account inactive when its pinned proxy pool retires. The next
// routine tick that queries social_accounts.is_active=true skips it; ops
// dashboards surface the retired_reason for reassignment.
async function burnAccount(acct: SocialAccount, reason: string): Promise<void> {
  if (!acct.id) return;
  const url = optionalWelesDatabase()?.url ?? '';
  const key = optionalWelesDatabase()?.token ?? '';
  if (!url || !key) return;
  const meta = (acct.metadata ?? {}) as Record<string, unknown>;
  const merged = {
    ...meta,
    retired_at: new Date().toISOString(),
    retired_reason: reason,
  };
  try {
    await fetch(`${url}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ is_active: false, metadata: merged }),
    });
  } catch (e) {
    console.error('[identity] burnAccount failed:', (e as Error).message);
  }
}

async function backfillPersona(acct: SocialAccount, persona: Persona): Promise<void> {
  if (!acct.id) return;
  const url = optionalWelesDatabase()?.url ?? '';
  const key = optionalWelesDatabase()?.token ?? '';
  if (!url || !key) return;
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
