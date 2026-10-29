// ---------------------------------------------------------------------------
// ProxyConfig interface & helpers
// ---------------------------------------------------------------------------

import {
  readOptionalPinnedProxyCredential,
  readOptionalWelesServiceSecret,
} from '../secrets/scoped-service.js';
import { providerFromHost } from './policy.js';
import type { ExitReputation } from './policy.js';
import {
  proxyTypeOf,
  secretServiceFor,
  stickyCredentials,
} from './sources/provider_credentials.js';

export { resolveProxy } from './resolve/resolve_proxy.js';

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol: string;
  country?: string;
  provider?: string;
  sticky?: boolean;
  proxy_type?: string;
  sticky_session_id?: string;
  sticky_hash?: string;
  city?: string;
  credential_ref?: string;
  credential_mode?: 'base' | 'exact';
}

export interface ResolvedProxy {
  server: string;
  username?: string;
  password?: string;
  country?: string;
  exit_ip?: string;
  platform?: string;
  provider?: string;
  proxy_type?: string;
  sticky_session_id?: string;
  sticky_hash?: string;
  city?: string;
  exit_reputation?: ExitReputation;
  /**
   * The base64 SHA-256 SPKI hashes of the certificate authority a provider
   * that intercepts TLS by design signs with, from its Skarbiec item's
   * `tls_spki` field. Chromium trusts exactly these for the session
   * (`--ignore-certificate-errors-spki-list`); every other certificate is
   * verified, so a proxy that intercepts without declaring them is refused by
   * the certificate error, never read through.
   */
  tls_spki?: string[];
}

/**
 * Build a full proxy URL from a config object.
 *
 * Output: `<protocol>://<user>:<password>@<host>:<port>`, credentials encoded.
 */
export function proxyUrl(config: ProxyConfig): string {
  const auth =
    config.username && config.password
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
      : config.username
        ? `${encodeURIComponent(config.username)}@`
        : '';
  return `${config.protocol}://${auth}${config.host}:${config.port}`;
}

/**
 * Convert a ProxyConfig into the shape Playwright's `browserType.launch`
 * expects for its `proxy` option.
 */
export function toPlaywright(config: ProxyConfig): {
  server: string;
  username?: string;
  password?: string;
} {
  const result: { server: string; username?: string; password?: string } = {
    server: `${config.protocol}://${config.host}:${config.port}`,
  };
  if (config.username) result.username = config.username;
  if (config.password) result.password = config.password;
  return result;
}

/**
 * Parse a proxy URL string back into a ProxyConfig.
 *
 * Accepts formats like:
 * - `http://host:port`
 * - `http://user:pass@host:port`
 * - `socks5://user:pass@host:port`
 */
export function parseProxyUrl(url: string): ProxyConfig {
  const parsed = new URL(url);
  return {
    protocol: parsed.protocol.replace(/:$/, ''),
    host: parsed.hostname,
    port: Number(parsed.port),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
}

/** A pinned proxy made usable again, or the field or secret that keeps it from being. */
export type HydratedPin = { proxy: ProxyConfig } | { refused: string };

/**
 * Rebuild a saved pin into the proxy it named, from what the pin recorded
 * and the provider's secrets. Nothing is inferred: a pin that does not state
 * its pool type, its provider or (for a sticky exit) its country and session
 * is refused naming the field (`pinned_proxy_incomplete:<field>`), so an
 * account never moves to an exit its pin did not name.
 */
export function hydratePinnedProxy(pin: ProxyConfig): HydratedPin {
  if (pin.username && pin.password) return { proxy: pin };
  const accountCredential = pin.credential_ref
    ? readOptionalPinnedProxyCredential(pin.credential_ref)
    : undefined;
  if (accountCredential && pin.credential_mode === 'exact') {
    return {
      proxy: {
        ...pin,
        username: accountCredential.username,
        password: accountCredential.password,
      },
    };
  }

  const provider = pin.provider ?? providerFromHost(pin.host);
  if (!provider) return { refused: 'pinned_proxy_incomplete:provider' };
  const proxyType = proxyTypeOf(pin.proxy_type);
  if (!proxyType) return { refused: 'pinned_proxy_incomplete:proxy_type' };
  let username = accountCredential?.username;
  let password = accountCredential?.password;
  if (!username || !password) {
    const secretService = secretServiceFor(provider, proxyType);
    if (!secretService)
      return {
        refused: `pinned_proxy_secret_undeclared:${provider}:${proxyType}`,
      };
    username = readOptionalWelesServiceSecret(secretService, 'username');
    password = readOptionalWelesServiceSecret(secretService, 'password');
    if (!username || !password)
      return { refused: `pinned_proxy_secret_unread:${secretService}` };
  }
  if (proxyType === 'isp')
    return {
      proxy: { ...pin, provider, proxy_type: proxyType, username, password },
    };

  // A sticky exit is rebuilt in the country and session it was pinned in.
  const sessionId = pin.sticky_session_id;
  if (!sessionId)
    return { refused: 'pinned_proxy_incomplete:sticky_session_id' };
  if (!pin.country) return { refused: 'pinned_proxy_incomplete:country' };
  const sticky = stickyCredentials(
    provider,
    proxyType,
    { username, password },
    {
      country: pin.country,
      city: pin.city,
      sessionId,
    },
  );
  return {
    proxy: {
      ...pin,
      provider,
      proxy_type: proxyType,
      username: sticky.username,
      password: sticky.password,
    },
  };
}

export class ProxyPool {
  private _proxies: ProxyConfig[] = [];
  get length(): number {
    return this._proxies.length;
  }
  add(config: ProxyConfig): void {
    this._proxies.push(config);
  }
  /** A random proxy, or the next one in turn, which then moves to the back. */
  next(random = false): ProxyConfig {
    if (!this._proxies.length) throw new Error('ProxyPool is empty');
    if (random)
      return this._proxies[Math.floor(Math.random() * this._proxies.length)];
    const first = this._proxies.shift() as ProxyConfig;
    this._proxies.push(first);
    return first;
  }
}
