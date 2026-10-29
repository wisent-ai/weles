// Per-account session identity: restore proxy + persona so register and
// login look like the same device. Reuses ProxyConfig/proxyUrl from the shared
// src/proxy/config.ts module. Account state is a Skarbiec record; if an older
// item has no persona yet, generate one and persist it back to that item.
//
// Extracted from src/utils/credentials.ts when that file crossed the
// 300-line cap. credentials.ts re-exports resolveAccountSession +
// AccountSession for backwards-compat with all existing callers.

import {
  dressPersona,
  generatePersona,
  type Persona,
  type PersonaDevice,
} from '../browser/persona.js';
import { sampleDevice } from '../browser/persona/device.js';
import { proxyUrl as buildProxyUrl, resolveProxy } from '../proxy/config.js';
import type { ProxyConfig, ResolvedProxy } from '../proxy/config.js';
import {
  noExitCause,
  rankByCapability,
  taskNetworkRequirements,
} from '../proxy/capability.js';
import type { SocialAccount } from '../utils/credentials.js';
import { hasSavedProxy, pinnedProxy, type SavedProxy } from './pinned_proxy.js';
import { backfillPersona, backfillProxy } from './repair.js';

export interface AccountSession {
  proxyUrl?: string;
  persona?: Persona;
  /** Whether proxyUrl is the account's own pin, which is never swapped. */
  pinned?: boolean;
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
  const savedProxy = meta?.proxy as SavedProxy | undefined;
  const saved = hasSavedProxy(savedProxy);

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
    !saved &&
    process.env.WELES_FORCE_PROXY !== '1'
  ) {
    if (meta?.persona) out.persona = meta.persona as Persona;
    return out;
  }

  if (saved) {
    cfg = await pinnedProxy(acct, savedProxy!, action, targetHost);
    out.pinned = true;
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
    if (!proxyType)
      throw new Error(
        `proxy_type_unstated:${action}:${acct.platform}: ${network.reason}, and names no proxy type to resolve`,
      );
    try {
      const tried: string[] = [];
      let pw: ResolvedProxy | undefined;
      const { candidates, failing, unpriced } = await rankByCapability(action);
      device = storedPersona ?? sampleDevice({});
      for (const winner of candidates) {
        const filter = [proxyType, winner.provider, network.country]
          .filter(Boolean)
          .join(' ');
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
        // The exit assigned now is the account's pin from here on.
        await backfillProxy(acct, cfg);
        out.pinned = true;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error('[identity] dynamic proxy assignment failed:', reason);
      throw new Error(`proxy_resolution_failed:${action}:${reason}`);
    }
  }

  if (cfg) out.proxyUrl = buildProxyUrl(cfg);
  out.persona =
    storedPersona ??
    dressPersona(device ?? sampleDevice({}), {
      country: cfg?.country ?? meta?.proxy?.country,
    });
  if (!storedPersona) await backfillPersona(acct, out.persona);
  return out;
}
