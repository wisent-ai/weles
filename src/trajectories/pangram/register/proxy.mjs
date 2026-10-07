/** The persona country a proxy URL implies, or undefined when it names none. */
export function countryHintFromProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  const cc = String(proxyUrl)
    .toLowerCase()
    .match(/\b(us|uk|gb|br|de|fr|nl|ca|au)\b/)?.[0];
  return cc === 'uk' ? 'gb' : cc;
}

/**
 * The proxy the registration runs through. Pangram is a direct-egress
 * platform in Weles' declared network policy (taskNetworkRequirements in
 * src/proxy/capability.ts), so the registration goes out directly unless the
 * operator names a proxy in PANGRAM_REGISTRATION_PROXY_URL. It used to pick an
 * ISP provider by capability anyway, tried a fixed number of them, assumed the
 * US when no country was set, and then fell back to direct egress when none
 * resolved: a route the policy never chose, taken silently.
 */
export function selectRegistrationProxy() {
  const explicit = process.env.PANGRAM_REGISTRATION_PROXY_URL;
  if (!explicit) return null;
  const u = new URL(explicit);
  return {
    proxyUrl: explicit,
    proxyConfig: {
      host: u.hostname,
      port: Number(u.port),
      protocol: u.protocol.replace(/:$/, ''),
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    },
  };
}
