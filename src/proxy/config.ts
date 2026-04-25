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

/**
 * Resolve a proxy type (residential, mobile, datacenter) or URL to Playwright proxy config.
 * Fetches available providers from the service_credentials Supabase table,
 * filters by balance > 0 and env var availability, returns the first working one.
 */
export async function resolveProxy(proxy: string): Promise<{ server: string; username?: string; password?: string } | undefined> {
  if (!proxy || proxy === 'none' || proxy === 'direct') return undefined;

  if (proxy.startsWith('http://') || proxy.startsWith('https://') || proxy.startsWith('socks')) {
    const u = new URL(proxy);
    return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) {
    console.log('[proxy] No Supabase credentials — cannot fetch providers');
    return undefined;
  }

  const res = await fetch(
    `${supabaseUrl}/rest/v1/service_credentials?category=eq.proxy&proxy_host=not.is.null&balance_usd=gt.0&select=display_name,proxy_host,proxy_port,api_key_env_var,balance_usd,metadata&order=balance_usd.desc`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) { console.log(`[proxy] Failed to fetch providers: ${res.status}`); return undefined; }
  type Row = { display_name: string; proxy_host: string; proxy_port: string; api_key_env_var: string; balance_usd: number; metadata?: { country?: string } };
  const providers = await res.json() as Row[];

  const typeFilter = proxy.toLowerCase();
  let filtered = typeFilter === 'residential' ? providers.filter(p => !p.display_name.toLowerCase().includes('mobile'))
    : typeFilter === 'mobile' ? providers.filter(p => p.display_name.toLowerCase().includes('mobile'))
    : providers;

  // Allow explicit provider name targeting (e.g. 'pingproxies', 'packetstream', 'oxylabs')
  const KNOWN_PROVIDERS = ['oxylabs', 'packetstream', 'pingproxies', 'iproyal', 'brightdata'];
  const explicit = KNOWN_PROVIDERS.find(n => typeFilter.includes(n));
  if (explicit) filtered = filtered.filter(p => p.display_name.toLowerCase().includes(explicit));

  // Shuffle so each call rotates across providers instead of always picking highest balance.
  // Important for sites (e.g. TikTok) that rate-limit per-provider IP pool rather than per-IP.
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }

  for (const p of filtered) {
    const envUser = p.api_key_env_var;
    const envPass = envUser?.replace('USERNAME', 'PASSWORD').replace('API_KEY', 'PASSWORD');
    const username = process.env[envUser] ?? '';
    const password = process.env[envPass] ?? '';
    if (!username || !password) {
      console.log(`[proxy] Skipping ${p.display_name}: missing env ${envUser}/${envPass}`);
      continue;
    }
    const { isBurned } = await import('./burned.js');
    const name = p.display_name.toLowerCase();
    const cc = (p.metadata?.country ?? 'us').toLowerCase();
    // Try up to 3 sticky sessions per provider — each fresh sessId may
    // resolve the residential gateway to a different exit IP. Skip any
    // host that is in the burned-IP registry.
    for (let attempt = 0; attempt < 3; attempt++) {
      const sessId = Math.floor(Math.random() * 9000000 + 1000000);
      let stickyUser = username, stickyPass = password;
      if (name.includes('oxylabs')) stickyUser = `customer-${username}-cc-${cc}-sessid-${sessId}`;
      else if (name.includes('packetstream')) stickyPass = `${password}_country-${cc.toUpperCase()}_session-${sessId}`;
      else if (name.includes('iproyal')) stickyPass = `${password}_country-${cc}_session-${sessId}`;
      else if (name.includes('pingproxies')) stickyUser = `${username}_c_${cc}_s_${sessId}`;
      let host = p.proxy_host;
      try { const dns = await import('node:dns'); host = await new Promise<string>((res, rej) => dns.lookup(p.proxy_host, (e: any, a: string) => e ? rej(e) : res(a))); } catch {}
      if (await isBurned(host)) continue;
      console.log(`[proxy] Using: ${p.display_name} (${host}:${p.proxy_port}, $${p.balance_usd}, sticky=${sessId})`);
      return { server: `http://${host}:${p.proxy_port}`, username: stickyUser, password: stickyPass };
    }
  }

  console.log(`[proxy] No working provider found for type="${proxy}"`);
  return undefined;
}
