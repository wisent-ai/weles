// ---------------------------------------------------------------------------
// ProxyConfig interface & helpers
// ---------------------------------------------------------------------------

import { readOptionalPinnedProxyCredential, readOptionalWelesServiceSecret } from '../secrets/scoped-service.js';
import { providerFromHost } from './policy.js';
import type { ExitReputation } from './policy.js';
import { proxyTypeOf, secretServiceFor, stickyCredentials } from './sources/provider_credentials.js';

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
}

/**
 * Build a full proxy URL from a config object.
 *
 * Example output: `http://user:pass@proxy.example.com:8080`
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

export function hydratePinnedProxy(pin: ProxyConfig): ProxyConfig | undefined {
  if (pin.username && pin.password) return pin;
  const accountCredential = pin.credential_ref
    ? readOptionalPinnedProxyCredential(pin.credential_ref)
    : undefined;
  if (accountCredential && pin.credential_mode === 'exact') {
    return { ...pin, username: accountCredential.username, password: accountCredential.password };
  }

  const provider = pin.provider ?? providerFromHost(pin.host);
  if (!provider) return undefined;
  const proxyType = proxyTypeOf(pin.proxy_type) ?? (provider === 'decodo' ? 'isp' : 'residential');
  let username = accountCredential?.username;
  let password = accountCredential?.password;
  if (!username || !password) {
    const secretService = secretServiceFor(provider, proxyType);
    if (!secretService) return undefined;
    username = readOptionalWelesServiceSecret(secretService, 'username');
    password = readOptionalWelesServiceSecret(secretService, 'password');
  }
  if (!username || !password) return undefined;
  if (proxyType === 'isp') return { ...pin, provider, proxy_type: proxyType, username, password };

  const sessionId = pin.sticky_session_id;
  if (!sessionId) return undefined;
  const sticky = stickyCredentials(provider, proxyType, { username, password }, {
    country: pin.country ?? 'us',
    city: pin.city,
    sessionId,
  });
  return {
    ...pin,
    provider,
    proxy_type: proxyType,
    username: sticky.username,
    password: sticky.password,
  };
}

export class ProxyPool {
  private _proxies: ProxyConfig[] = [];
  private _index = 0;
  get length(): number { return this._proxies.length; }
  add(config: ProxyConfig): void { this._proxies.push(config); }
  next(random = false): ProxyConfig {
    if (this._proxies.length === 0) throw new Error('ProxyPool is empty');
    if (random) return this._proxies[Math.floor(Math.random() * this._proxies.length)];
    const proxy = this._proxies[this._index % this._proxies.length];
    this._index++;
    return proxy;
  }
}
