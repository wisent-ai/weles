// The proxy an account's saved pin rebuilds into. A pin is the account's one
// exit: it is rebuilt only from what the pin states, refused by name when it
// cannot be, and a pinned proxy that no longer opens a tunnel ends the
// session instead of being rotated or replaced by another exit.

import { hydratePinnedProxy } from '../proxy/config.js';
import type { HydratedPin, ProxyConfig } from '../proxy/config.js';
import { isBurned } from '../proxy/burned.js';
import { isCellFail } from '../proxy/capability.js';
import { providerFromHost, retiredProviderReason } from '../proxy/policy.js';
import { pinnedExitRefusal } from '../proxy/pinned_exit.js';
import type { SocialAccount } from '../utils/credentials.js';
import { burnAccount } from './repair.js';

export type SavedProxy = Partial<ProxyConfig> & {
  server?: string;
  exit_ip_url?: string;
};

/** Whether the account record holds a pin at all. */
export function hasSavedProxy(saved: SavedProxy | undefined): boolean {
  return Boolean(
    saved?.exit_ip_url || (saved?.host && saved?.port) || saved?.server,
  );
}

/** The proxy a saved pin rebuilds into; a pin that cannot be rebuilt throws why. */
function pinned(hydrated: HydratedPin): ProxyConfig {
  if ('refused' in hydrated) throw new Error(hydrated.refused);
  return hydrated.proxy;
}

/** A pin written as a URL (`exit_ip_url` or `server`), with the fields beside it. */
function fromUrl(
  url: string,
  saved: SavedProxy,
  credentials: 'url' | 'record',
): ProxyConfig {
  const parsed = new URL(url);
  const username =
    credentials === 'url'
      ? parsed.username
        ? decodeURIComponent(parsed.username)
        : undefined
      : saved.username;
  const provider =
    saved.provider ?? providerFromHost(parsed.hostname, username);
  if (!provider) throw new Error('unknown_provider');
  return pinned(
    hydratePinnedProxy({
      host: parsed.hostname,
      port: Number(parsed.port),
      protocol: parsed.protocol.replace(/:$/, ''),
      username,
      password:
        credentials === 'url'
          ? parsed.password
            ? decodeURIComponent(parsed.password)
            : undefined
          : saved.password,
      country: saved.country,
      provider,
      proxy_type: saved.proxy_type,
      sticky_session_id: saved.sticky_session_id,
      sticky_hash: saved.sticky_hash,
      city: saved.city,
    }),
  );
}

/** A pin written as host and port: refused when burned, retired or unknown. */
async function fromHost(
  acct: SocialAccount,
  saved: SavedProxy & { host: string; port: number },
  action: string,
): Promise<ProxyConfig> {
  const { host, port } = saved;
  if (await isBurned(host, acct.platform))
    throw new Error(`pinned_proxy_burned:${action}:${host}:${port}`);
  const retiredReason = retiredProviderReason(host, port);
  if (retiredReason) {
    console.log(
      `[identity] retiring account ${acct.username}: stored proxy ${host}:${port} is from a retired pool (${retiredReason})`,
    );
    await burnAccount(acct, `retired_proxy:${retiredReason}`);
    throw new Error(`retired_proxy:${retiredReason}:${host}:${port}`);
  }
  // A pool that is retired is declared in proxy/policy.ts and refused above;
  // a pin naming no provider Weles knows cannot be rebuilt.
  const provider = saved.provider ?? providerFromHost(host, saved.username);
  if (!provider) {
    await burnAccount(acct, 'retired_proxy:unknown_provider');
    throw new Error(
      `pinned_proxy_unavailable:${action}:${host}:${port}: the pin names no provider and its host is no provider's`,
    );
  }
  if (await isCellFail(provider, action))
    throw new Error(`capability_failed:${provider}:${action}`);
  // A saved proxy states its pool type, protocol and, for a sticky exit,
  // its country; hydratePinnedProxy refuses one that does not.
  if (!saved.protocol)
    throw new Error(
      `pinned_proxy_invalid:${action}:${host}:${port} records no protocol`,
    );
  const hydrated = hydratePinnedProxy({
    ...saved,
    host,
    port,
    protocol: saved.protocol,
    provider,
  });
  if ('refused' in hydrated)
    throw new Error(`pinned_proxy_invalid:${action}:${hydrated.refused}`);
  return hydrated.proxy;
}

/**
 * The account's pinned proxy, proved to open a tunnel to `targetHost`. A
 * pin that cannot be rebuilt, or whose proxy refuses the tunnel, throws
 * `pinned_proxy_invalid` / `dead_pinned_proxy` with the cause; the pin is
 * left as it is, for the operator to repair or retire.
 */
export async function pinnedProxy(
  acct: SocialAccount,
  saved: SavedProxy,
  action: string,
  targetHost: string | undefined,
): Promise<ProxyConfig> {
  let cfg: ProxyConfig;
  if (saved.exit_ip_url || saved.server) {
    try {
      cfg = saved.exit_ip_url
        ? fromUrl(saved.exit_ip_url, saved, 'url')
        : fromUrl(saved.server!, saved, 'record');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`pinned_proxy_invalid:${action}:${reason}`);
    }
  } else {
    cfg = await fromHost(
      acct,
      saved as SavedProxy & { host: string; port: number },
      action,
    );
  }
  const refusal = await pinnedExitRefusal(cfg, targetHost);
  if (refusal)
    throw new Error(
      `dead_pinned_proxy:${action}:${cfg.provider ?? 'provider_not_recorded'}:${cfg.host}:${cfg.port}: ${refusal}; the account keeps its one exit, so the session does not start on another`,
    );
  return cfg;
}
