// Per-account session identity: restore proxy + persona so register and
// login look like the same device. Reuses ProxyConfig/proxyUrl from the shared
// src/proxy/config.ts module. Account state is a Skarbiec record; if an older
// item has no persona yet, generate one and persist it back to that item.
//
// Extracted from src/utils/credentials.ts when that file crossed the
// 300-line cap. credentials.ts re-exports resolveAccountSession +
// AccountSession for backwards-compat with all existing callers.

import { dressPersona, generatePersona, type Persona, type PersonaDevice } from '../browser/persona.js';
import { sampleDevice } from '../browser/persona/device.js';
import {
  hydratePinnedProxy,
  proxyUrl as buildProxyUrl,
  resolveProxy,
} from '../proxy/config.js';
import type { HydratedPin, ProxyConfig, ResolvedProxy } from '../proxy/config.js';
import { isBurned } from '../proxy/burned.js';
import {
  noExitCause,
  rankByCapability,
  taskNetworkRequirements,
} from '../proxy/capability.js';
import { refreshStickyIfDead } from '../proxy/sticky.js';
import type { SocialAccount } from '../utils/credentials.js';
import {
  backfillPersona,
  backfillProxy,
  burnAccount,
  clearDeadProxy,
} from './repair.js';

export interface AccountSession {
  proxyUrl?: string;
  persona?: Persona;
}

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

/** The proxy a saved pin rebuilds into; a pin that cannot be rebuilt throws why. */
function pinned(hydrated: HydratedPin): ProxyConfig {
  if ('refused' in hydrated) throw new Error(hydrated.refused);
  return hydrated.proxy;
}

// The action this run performs, as the worker states it (runChildIdentity
// sets ACTION for every run it spawns). Which network the run needs is read
// from it, so a run without it is refused rather than given a name guessed
// from its script's path.
function trajectoryAction(): string {
  const stated = process.env.ACTION?.trim();
  if (stated) return stated;
  throw new Error(
    `ACTION is not set for ${process.argv[1]}: the account session reads the run's network requirements by its action; run it through the Weles worker or set ACTION to the action it performs`,
  );
}

export async function resolveAccountSession(
  acct: SocialAccount,
): Promise<AccountSession> {
  const meta = acct.metadata as any;
  const out: AccountSession = {};
  let cfg: ProxyConfig | undefined;
  const storedPersona = meta?.persona as Persona | undefined;
  // The device the exit preflight presents: the stored persona, else one sampled before the proxy resolves.
  let device: PersonaDevice | undefined;
  const action = trajectoryAction();
  const targetHost = PLATFORM_HOSTS[acct.platform];

  const network = taskNetworkRequirements(action, acct.platform);
  const savedProxy = meta?.proxy as
    | (Partial<ProxyConfig> & { server?: string; exit_ip_url?: string })
    | undefined;
  const hasSavedProxy = Boolean(
    savedProxy?.exit_ip_url ||
      (savedProxy?.host && savedProxy?.port) ||
      savedProxy?.server,
  );

  // First-party direct egress (NO proxy). taskNetworkRequirements already routes
  // the platforms with no datacenter blacklist — GitHub, Producthunt, Pangram —
  // straight to `route: 'direct'`. Apple is the separate, first-party case: we
  // sign into our OWN account authentically from this trusted Mac Mini, which is
  // the native two-factor device, so masking the real IP is pointless and even
  // harmful — a proxy just injects a foreign IP that Apple distrusts, and ISP
  // providers are unset for it anyway, so forcing one only breaks the run.
  // Managed multi-account social platforms (Reddit/Twitter/Instagram/Discord/
  // TikTok/LinkedIn) still REQUIRE a proxy for IP diversity / anti-ban.
  if (acct.platform === 'apple' && process.env.WELES_FORCE_PROXY !== '1') {
    if (meta?.persona) out.persona = meta.persona as Persona;
    return out;
  }

  // Capability-bootstrap force-override: exercise one explicit provider without
  // mutating the account's permanent pin.
  if (process.env.PROXY_URL && process.env.PROXY_URL_FORCE === '1') {
    out.proxyUrl = process.env.PROXY_URL;
    out.persona = (meta?.persona as Persona | undefined) ?? generatePersona({});
    return out;
  }

  if (
    network.route === 'direct' &&
    !hasSavedProxy &&
    process.env.WELES_FORCE_PROXY !== '1'
  ) {
    if (meta?.persona) out.persona = meta.persona as Persona;
    return out;
  }

  const policy = await import('../proxy/policy.js');
  if (savedProxy?.exit_ip_url) {
    try {
      const parsed = new URL(savedProxy.exit_ip_url);
      const provider =
        savedProxy.provider ??
        policy.providerFromHost(parsed.hostname, parsed.username);
      if (!provider) throw new Error('unknown_provider');
      cfg = pinned(hydratePinnedProxy({
          host: parsed.hostname,
          port: Number(parsed.port),
          protocol: parsed.protocol.replace(/:$/, ''),
          username: parsed.username
            ? decodeURIComponent(parsed.username)
            : undefined,
          password: parsed.password
            ? decodeURIComponent(parsed.password)
            : undefined,
          country: savedProxy.country,
          provider,
          proxy_type: savedProxy.proxy_type,
          sticky_session_id: savedProxy.sticky_session_id,
          sticky_hash: savedProxy.sticky_hash,
          city: savedProxy.city,
        }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`pinned_proxy_invalid:${action}:${reason}`);
    }
  } else if (savedProxy?.host && savedProxy?.port) {
    const host = savedProxy.host;
    if (await isBurned(host, acct.platform))
      throw new Error(
        `pinned_proxy_burned:${action}:${host}:${savedProxy.port}`,
      );
    const retiredReason = policy.retiredProviderReason(host, savedProxy.port);
    if (retiredReason) {
      console.log(
        `[identity] retiring account ${acct.username}: stored proxy ${host}:${savedProxy.port} is from a retired pool (${retiredReason})`,
      );
      await burnAccount(acct, `retired_proxy:${retiredReason}`);
      throw new Error(
        `retired_proxy:${retiredReason}:${host}:${savedProxy.port}`,
      );
    }
    // A pool that is retired is declared in proxy/policy.ts and refused above;
    // a pin naming no provider Weles knows cannot be rebuilt.
    const provider =
      savedProxy.provider ?? policy.providerFromHost(host, savedProxy.username);
    if (!provider) {
      await burnAccount(acct, 'retired_proxy:unknown_provider');
      throw new Error(
        `pinned_proxy_unavailable:${action}:${host}:${savedProxy.port}: the pin names no provider and its host is no provider's`,
      );
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
    // A saved proxy states its pool type, protocol and, for a sticky exit,
    // its country; hydratePinnedProxy refuses one that does not.
    if (!savedProxy.protocol) {
      throw new Error(`pinned_proxy_invalid:${action}:${host}:${savedProxy.port} records no protocol`);
    }
    const hydrated = hydratePinnedProxy({ ...savedProxy, host, port: savedProxy.port, protocol: savedProxy.protocol, provider });
    if ('refused' in hydrated) throw new Error(`pinned_proxy_invalid:${action}:${hydrated.refused}`);
    cfg = hydrated.proxy;
  } else if (savedProxy?.server) {
    try {
      const parsed = new URL(savedProxy.server);
      const provider =
        savedProxy.provider ??
        policy.providerFromHost(parsed.hostname, savedProxy.username);
      if (!provider) throw new Error('unknown_provider');
      cfg = pinned(hydratePinnedProxy({
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
        }));
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
      // A provider the pinned proxy never recorded is named so, not "unknown".
      const reason = `dead_pinned_proxy:${action}:${cfg.provider ? cfg.provider : 'provider_not_recorded'}`;
      console.log(
        `[identity] failing over account ${acct.username}: ${reason}`,
      );
      await clearDeadProxy(acct, reason);
      cfg = undefined;
    }
  }

  if (!cfg && process.env.PROXY_URL) {
    out.proxyUrl = process.env.PROXY_URL;
  } else if (!cfg && process.env.WELES_ALLOW_DIRECT_ACCOUNT_SESSION === '1') {
    console.log(
      `[identity] explicit direct account session action=${action} platform=${acct.platform}`,
    );
  } else if (!cfg) {
    // The pool type and country the run's network names; a run that needs a proxy names its type.
    const proxyType = network.proxyType;
    if (!proxyType) throw new Error(`proxy_type_unstated:${action}:${acct.platform}: ${network.reason}, and names no proxy type to resolve`);
    try {
      const tried: string[] = [];
      let pw: ResolvedProxy | undefined;
      const { candidates, failing, unpriced } = await rankByCapability(action);
      device = storedPersona ?? sampleDevice({});
      for (const winner of candidates) {
        const filter = [proxyType, winner.provider, network.country].filter(Boolean).join(' ');
        pw = await resolveProxy(filter, targetHost, device);
        if (pw) {
          console.log(
            `[identity] capability pick ${winner.provider} ($${winner.cost_per_gb}/GB, ${winner.standing}) route=${proxyType} action=${action}`,
          );
          break;
        }
        tried.push(winner.provider);
      }
      if (!pw) {
        throw new Error(
          `proxy_unavailable:${proxyType}:${action}:${acct.platform}:${network.country}: ${noExitCause(action, tried, failing, unpriced)}`,
        );
      }
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
  out.persona = storedPersona ?? dressPersona(device ?? sampleDevice({}), { country: cfg?.country ?? meta?.proxy?.country });
  if (!storedPersona) await backfillPersona(acct, out.persona);
  return out;
}
