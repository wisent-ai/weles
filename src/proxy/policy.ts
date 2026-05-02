// Provider-platform toxicity policy. Lifted from credentials.ts so the
// check can fire from both the per-account path (resolveAccountSession)
// AND the URL-form path inside resolveProxy. Without this lift, a caller
// passing PROXY_URL=http://...@proxy.packetstream.io:... for a reddit
// register would bypass the per-account check entirely.

// Replaced by data-driven proxy_capability_matrix in src/proxy/capability.ts.
// The hardcoded toxicity table conflicted with matrix-passing cells (e.g.
// PacketStream for tiktok was blocked here even when the matrix had data
// showing recent passes). Cold-start cost is one bad attempt per
// (provider, action) cell — the matrix marks it 'fail' immediately and
// future selects skip it. No more policy embedded in code.
const PROVIDER_PLATFORM_BLOCK: Record<string, string[]> = {};

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

// Country-verify a proxy exit IP via ip-api.com.
// Providers (Oxylabs in particular) sometimes route residential traffic
// through a non-US exit when their US pool is exhausted. TikTok routes
// geo-mismatched sessions to the ttp2 security cluster which fails the
// SubtleCrypto fingerprint step and returns error_code 1340 at
// register_verify_login. Confirmed via diff harness vs chrome reference
// 2026-05-01: success run had subtleCrypto.count=6 + mssdk.tiktokw.us,
// 1340 run had subtleCrypto.count=0 + mssdk-ttp2.tiktokw.us. Differentiator
// was geo: success ran from US exit, failure from BR exit (186.195.52.156).
export type GeoCheckResult = 'match' | 'mismatch' | 'unknown';
export async function verifyExitCountry(exitIp: string, expectedCc: string, timeoutMs = 3500): Promise<{ result: GeoCheckResult; exitCc?: string }> {
  if (!exitIp || !expectedCc) return { result: 'unknown' };
  try {
    const ctl = AbortSignal.timeout(timeoutMs);
    const r = await fetch(`http://ip-api.com/json/${exitIp}?fields=countryCode`, { signal: ctl });
    const j = (await r.json()) as { countryCode?: string };
    const exitCc = (j?.countryCode || '').toLowerCase();
    if (!exitCc) return { result: 'unknown' };
    if (exitCc === expectedCc.toLowerCase()) return { result: 'match', exitCc };
    return { result: 'mismatch', exitCc };
  } catch {
    return { result: 'unknown' };
  }
}

// TikTok edge-classifier probe. The /signup HTML embeds a SIGI_STATE
// "vregion" value that pins mssdk routing for the rest of the session:
// "US-TTP" = standard (mssdk.tiktokw.us), "US-TTP2" = high-risk
// (mssdk-ttp2.tiktokw.us) where the security SDK never completes init
// and the click handler bails before firing /send_code/. 2026-05-02
// probe of 5 random BrightData residential stickies: 4 US-TTP2, 1 US-TTP.
// Reject US-TTP2 stickies in preflight; resolveProxy 8-attempt loop
// walks past them before binding the browser.
export type RoutingResult = 'standard' | 'high_risk' | 'unknown';
export async function verifyTikTokRouting(proxyUrl: string, secs = 12): Promise<{ result: RoutingResult; vregion?: string }> {
  if (!proxyUrl) return { result: 'unknown' };
  try {
    const { execSync } = await import('node:child_process');
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
    const body = execSync(`curl -s --max-time ${secs} -x "${proxyUrl}" -H "User-Agent: ${ua}" "https://www.tiktok.com/signup"`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const m = body.match(/"vregion":"([A-Z0-9-]{1,20})"/);
    if (!m) return { result: 'unknown' };
    const vregion = m[1];
    if (/-TTP2$/i.test(vregion)) return { result: 'high_risk', vregion };
    return { result: 'standard', vregion };
  } catch {
    return { result: 'unknown' };
  }
}
