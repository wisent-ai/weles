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

  // Direct egress for platforms with NO datacenter blacklist. GitHub and
  // Producthunt accept VM IP. LinkedIn HEAD 200 from VM but actual load
  // triggers PerimeterX immediately on datacenter — reverted 2026-04-26.
  // Reddit/Twitter/Instagram/Discord/TikTok all 403 from datacenter.
  const DIRECT_EGRESS_OK = new Set(['github', 'producthunt']);
  if (DIRECT_EGRESS_OK.has(acct.platform) && process.env.WELES_FORCE_PROXY !== '1') {
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
    const PHOST: Record<string, string> = { twitter: 'x.com', linkedin: 'www.linkedin.com', instagram: 'www.instagram.com', reddit: 'www.reddit.com', tiktok: 'www.tiktok.com', discord: 'discord.com', github: 'github.com', producthunt: 'www.producthunt.com' };
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
        const filter = `residential ${winner.provider} ${country}`.trim();
        pw = await mod.resolveProxy(filter, targetHost);
        if (pw) {
          console.log(`[identity] capability pick ${winner.provider} ($${winner.cost_per_gb}/GB) for action=${action}`);
          break;
        }
        tried.push(winner.provider);
      }
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
