import { lookup } from 'node:dns/promises';

// The proxy fields a reCAPTCHA solving task carries, in the two dialects the
// services speak: createTask's address-and-port fields, and NopeCHA's.

export type ProxyCredentials = {
  server?: string;
  username?: string;
  password?: string;
};

// The proxy URL a task names, which must carry its port: the services take
// the proxy as address and port, and a URL without one read as port NaN, so
// the task went out naming no usable proxy.
function proxyUrl(server: string): URL {
  const u = new URL(server);
  if (!u.port)
    throw new Error(
      `captcha proxy ${u.hostname} names no port; the solving services need one`,
    );
  return u;
}

// The proxy fields of a createTask task. The services require the proxy by IP
// address, so a host that does not resolve fails here with its cause rather
// than going out as a name the services refuse.
export async function proxyTaskFields(
  proxy?: ProxyCredentials,
): Promise<Record<string, any> | null> {
  if (!proxy?.server) return null;
  const u = proxyUrl(proxy.server);
  let ip: string;
  try {
    ({ address: ip } = await lookup(u.hostname));
  } catch (error) {
    throw new Error(
      `captcha proxy ${u.hostname} did not resolve to an address the solving services accept: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return {
    proxyType: u.protocol.replace(':', ''),
    proxyAddress: ip,
    proxyPort: Number(u.port),
    proxyLogin: proxy.username,
    proxyPassword: proxy.password,
  };
}

export function nopechaProxyFields(
  proxy?: ProxyCredentials,
): Record<string, any> | null {
  if (!proxy?.server) return null;
  const u = proxyUrl(proxy.server);
  const out: Record<string, any> = {
    scheme: u.protocol.replace(':', ''),
    host: u.hostname,
    port: Number(u.port),
  };
  if (proxy.username) out.username = proxy.username;
  if (proxy.password) out.password = proxy.password;
  return out;
}
