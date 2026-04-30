// Provider-platform toxicity policy. Lifted from credentials.ts so the
// check can fire from both the per-account path (resolveAccountSession)
// AND the URL-form path inside resolveProxy. Without this lift, a caller
// passing PROXY_URL=http://...@proxy.packetstream.io:... for a reddit
// register would bypass the per-account check entirely.

const PROVIDER_PLATFORM_BLOCK: Record<string, string[]> = {
  // PacketStream's residential range gets reddit accounts insta-shadowbanned —
  // signup completes, cookies return, account 404s within ~10 min after
  // first comment. Verified across multiple accounts this session.
  packetstream: ['reddit', 'tiktok'],
  // Oxylabs residential exit IPs hit ERR_HTTP_RESPONSE_CODE_FAILURE at the
  // edge on linkedin/twitter login pages.
  oxylabs: ['linkedin', 'twitter'],
};

// Map a proxy hostname (or hostname-like substring) back to its provider name.
// Used when resolveProxy receives a fully-qualified PROXY_URL and we need to
// derive the provider for the toxicity check before launching the session.
const HOST_PROVIDER_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\.)proxy\.packetstream\.io$/i, 'packetstream'],
  [/(^|\.)pingproxies\.com$/i, 'pingproxies'],
  [/(^|\.)oxylabs\.io$/i, 'oxylabs'],
  [/(^|\.)iproyal\.com$/i, 'iproyal'],
  [/(^|\.)brd\.superproxy\.io$/i, 'brightdata'],
  [/(^|\.)brightdata\.com$/i, 'brightdata'],
];

// Username patterns: stored proxies are often IP-form (BrightData routes
// residential traffic through gateway IPs in DC ranges like 137.184.x), so
// hostname matching alone misses them. The username carries an unmistakable
// provider-specific shape — use it as a fallback.
const USER_PROVIDER_PATTERNS: Array<[RegExp, string]> = [
  [/^brd-customer-/i, 'brightdata'],
  [/^customer-.*-cc-[a-z]{2}-sessid-\d+/i, 'oxylabs'],
  [/_c_[a-z]{2}_s_\d+/i, 'pingproxies'],
];

export function providerFromHost(host: string | undefined, username?: string): string | undefined {
  if (host) {
    for (const [pat, name] of HOST_PROVIDER_PATTERNS) if (pat.test(host)) return name;
  }
  if (username) {
    for (const [pat, name] of USER_PROVIDER_PATTERNS) if (pat.test(username)) return name;
  }
  return undefined;
}

export function isProviderBlockedForPlatform(provider: string | undefined, platform: string | undefined): boolean {
  if (!provider || !platform) return false;
  return (PROVIDER_PLATFORM_BLOCK[provider] ?? []).includes(platform);
}

// Return the same data structure for callers (credentials.ts) that build
// PROVIDERS lists by filtering against the policy.
export function blockedProvidersForPlatform(platform: string): string[] {
  const out: string[] = [];
  for (const [prov, plats] of Object.entries(PROVIDER_PLATFORM_BLOCK)) if (plats.includes(platform)) out.push(prov);
  return out;
}
