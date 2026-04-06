// ---------------------------------------------------------------------------
// ProxyConfig interface & helpers
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol: string;
  country?: string;
  provider?: string;
  sticky?: boolean;
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

// ---------------------------------------------------------------------------
// ProxyPool
// ---------------------------------------------------------------------------

export class ProxyPool {
  private _proxies: ProxyConfig[] = [];
  private _index = 0;

  get length(): number {
    return this._proxies.length;
  }

  /**
   * Add a proxy configuration to the pool.
   */
  add(config: ProxyConfig): void {
    this._proxies.push(config);
  }

  /**
   * Return the next proxy using round-robin selection.
   * If `random` is `true`, pick one at random instead.
   */
  next(random = false): ProxyConfig {
    if (this._proxies.length === 0) {
      throw new Error('ProxyPool is empty');
    }
    if (random) {
      const idx = Math.floor(Math.random() * this._proxies.length);
      return this._proxies[idx];
    }
    const proxy = this._proxies[this._index % this._proxies.length];
    this._index++;
    return proxy;
  }
}
