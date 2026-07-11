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
import { proxyUrl as buildProxyUrl, type ProxyConfig } from '../proxy/config.js';
import { isBurned } from '../proxy/burned.js';
import { refreshStickyIfDead } from '../proxy/sticky.js';
import type { SocialAccount } from '../utils/credentials.js';

export interface AccountSession { proxyUrl?: string; persona?: Persona; }

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

  // Direct egress (NO proxy) for platforms that don't need IP-masking. Two
  // kinds: platforms with no datacenter blacklist that accept the VM IP
  // (GitHub, Producthunt, Pangram — no blocks / no CAPTCHA in testing); and
  // first-party accounts we own and log into authentically, where masking our
  // real IP is pointless and even harmful — Apple / App Store Connect signs in
  // as our OWN account from this trusted Mac Mini (the native two-factor
  // device), so a proxy just injects a foreign IP that Apple distrusts. ISP
  // providers are unset here anyway, so forcing a proxy only breaks the run.
  // Managed multi-account social platforms (Reddit/Twitter/Instagram/Discord/
  // TikTok/LinkedIn) still REQUIRE a proxy for IP diversity / anti-ban.
  const DIRECT_EGRESS_OK: Record<string, true> = { github: true, producthunt: true, pangram: true, apple: true };
  if (DIRECT_EGRESS_OK[acct.platform] && process.env.WELES_FORCE_PROXY !== '1') {
    if (meta?.persona) out.persona = meta.persona as Persona;
    return out;
  }

  // Capability-bootstrap force-override: test a specific provider regardless
  // of stored proxy. Set by worker/poll when params.proxy_url_override is
  // present. Highest priority so we get deterministic provider control.
  if (process.env.PROXY_URL && process.env.PROXY_URL_FORCE === '1') {
    out.proxyUrl = process.env.PROXY_URL;
    out.persona = (meta?.persona as Persona | undefined) ?? generatePersona({});
    return out;
  }

  // Static-IP pin per account. When metadata.proxy.exit_ip_url is set, the
  // account has a dedicated /32 (ISP/static-residential product) reserved.
  // Bypass all rotation logic and use that exact URL. If the row also has
  // a persisted persona, return both immediately. If the static URL is set
  // but unreachable, refuse rather than silently fall back to a rotating
  // sticky — drift is exactly what static IPs exist to prevent.
  if (typeof meta?.proxy?.exit_ip_url === 'string' && meta.proxy.exit_ip_url) {
    out.proxyUrl = meta.proxy.exit_ip_url as string;
    out.persona = (meta?.persona as Persona | undefined) ?? generatePersona({ country: meta?.proxy?.country });
    return out;
  }

  if (meta?.proxy?.host && meta?.proxy?.port && !(await isBurned(meta.proxy.host))) {
    // Retired-provider gate. Each account is pinned to one dedicated ISP IP
    // at registration; when the pinned pool retires (Oxylabs Residential
    // rotating port 7777, legacy lbartoszcze 209.38.* relay), the account
    // retires with it. Mark is_active=false and refuse the run rather than
    // rerouting through any other provider — the principle is "one dedicated
    // ISP per account, no shuffle" pinned 2026-05-21 by user mandate.
    const policy = await import('../proxy/policy.js');
    // Defensive: if dist/ is stale and the new export isn't there, skip the
    // retired gate rather than crash the trajectory with "is not a function".
    const retiredReason = typeof policy.retiredProviderReason === 'function'
      ? policy.retiredProviderReason(meta.proxy.host as string, meta.proxy.port as number)
      : undefined;
    if (retiredReason) {
      console.log(`[identity] retiring account ${acct.username}: stored proxy ${meta.proxy.host}:${meta.proxy.port} is from a retired pool (${retiredReason})`);
      await burnAccount(acct, `retired_proxy:${retiredReason}`);
      throw new Error(`retired_proxy:${retiredReason}:${meta.proxy.host}:${meta.proxy.port}`);
    }
    const storedProvider = policy.providerFromHost(meta.proxy.host as string, meta.proxy.username as string);
    const isLegacyRelay = !storedProvider && (meta.proxy.username === 'lbartoszcze' || /^209\.38\./.test(meta.proxy.host as string));
    let storedFailing = false;
    if (storedProvider) {
      try {
        const { isCellFail } = await import('../proxy/capability.js');
        storedFailing = await isCellFail(storedProvider, action);
      } catch { /* capability lookup best-effort */ }
    }
    if (isLegacyRelay) {
      console.log(`[identity] dropping stored legacy/datacenter proxy ${meta.proxy.host}:${meta.proxy.port} — falling through to provider selection`);
    } else if (storedFailing) {
      console.log(`[identity] capability matrix marks ${storedProvider}/${action} as fail — dropping stored proxy`);
    } else {
      const refreshed = await refreshStickyIfDead(meta.proxy as ProxyConfig);
      if (refreshed) { cfg = refreshed; if (refreshed !== meta.proxy) await backfillProxy(acct, refreshed); }
    }
  } else if (meta?.proxy?.server) {
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
    const country = acct.platform === 'discord' ? '' : 'us';
    const PHOST: Record<string, string> = { twitter: 'x.com', linkedin: 'www.linkedin.com', instagram: 'www.instagram.com', reddit: 'www.reddit.com', tiktok: 'www.tiktok.com', discord: 'discord.com', github: 'github.com', producthunt: 'www.producthunt.com', pangram: 'www.pangram.com' };
    const targetHost = PHOST[acct.platform];
    try {
      const { selectByCapability } = await import('../proxy/capability.js');
      const mod = await import('../proxy/config.js');
      const tried: string[] = [];
      let pw: Awaited<ReturnType<typeof mod.resolveProxy>> | undefined;
      for (let i = 0; i < 5; i++) {
        const winner = await selectByCapability(action, tried);
        if (!winner) {
          console.log(`[identity] no provider passes capability for action=${action} platform=${acct.platform}`);
          break;
        }
        const filter = `isp ${winner.provider} ${country}`.trim();
        pw = await mod.resolveProxy(filter, targetHost);
        if (pw) {
          console.log(`[identity] capability pick ${winner.provider} ($${winner.cost_per_gb}/GB) for action=${action}`);
          break;
        }
        tried.push(winner.provider);
      }
      if (!pw) { console.error(`[identity] no isp proxy resolved for action=${action} platform=${acct.platform} country=${country}; user rule: ISP for everything`); throw new Error('no_isp_proxy'); }
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
  // True backfill: never overwrite a registration-time proxy with a different
  // host. Only update when the existing row is absent OR the host matches
  // (sticky-session-id refresh on the same provider host). This preserves the
  // IP binding established at saveAccount/registration time across rotations
  // through dynamic selectByCapability fallthroughs and legacy-filter drops.
  // Without this guard, every login attempt that fell through clobbered the
  // registration value, destroying the cookies<->exit-IP binding that
  // LinkedIn (and every PerimeterX-protected platform) reads on session
  // resume — see metadata.proxy on sagekoepp7919 going from PacketStream
  // 209.38.175.14 → Oxylabs 195.86.126.156 within one session.
  const existingHost = (acct.metadata as any)?.proxy?.host;
  const existingPort = (acct.metadata as any)?.proxy?.port;
  if (existingHost && (existingHost !== cfg.host || existingPort !== cfg.port)) {
    console.log(`[identity] backfillProxy: preserving registration-time proxy ${existingHost}:${existingPort} (refusing overwrite to ${cfg.host}:${cfg.port})`);
    return;
  }
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

// Mark an account inactive when its pinned proxy pool retires. The next
// routine tick that queries social_accounts.is_active=true skips it; ops
// dashboards surface the retired_reason for reassignment.
async function burnAccount(acct: SocialAccount, reason: string): Promise<void> {
  if (!acct.id) return;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
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
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
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
