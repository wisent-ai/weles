import { enqueueAction } from '../state/skarbiec-records.js';

// Provider-platform toxicity policy. Lifted from credentials.ts so the
// check can fire from both the per-account path (resolveAccountSession)
// AND the URL-form path inside resolveProxy. Without this lift, a caller
// passing PROXY_URL=http://...@proxy.packetstream.io:... for a reddit
// register would bypass the per-account check entirely.

// Most provider/platform pairs are governed by the data-driven
// proxy_capability_matrix in src/proxy/capability.ts. Hard exclusions
// stay here because they're CLAUDE.md auto-rules, not statistical
// observations. PacketStream + LinkedIn is one such rule: PacketStream's
// residential range is flagged by LinkedIn anti-bot; signups consistently land
// on /checkpoint, so the pair remains a hard exclusion.
const PROVIDER_PLATFORM_BLOCK: Record<string, string[]> = {
  packetstream: ['linkedin'],
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
  [/(^|\.)decodo\.com$/i, 'decodo'],
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

// Retired provider pools. Accounts whose stored metadata.proxy points at one
// of these MUST be burned (is_active=false) rather than rerouted through any
// other provider. The principle pinned 2026-05-21: one dedicated ISP IP per
// account, set at registration time, used forever. When the pinned pool
// retires, the account retires with it.
//
// Each retired pattern names what we observed in the wild:
//   - pr.oxylabs.io / 195.86.* / 152.233.* on port 7777: Oxylabs Residential
//     rotating gateway. Banned for LinkedIn and every account-bound flow
//     since the exit IP changes per request, which breaks persona<->IP
//     binding the platforms key on.
const RETIRED_PROVIDER_HOSTS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\.)pr\.oxylabs\.io$/i,        reason: 'oxylabs_residential_rotating' },
  { pattern: /^195\.86\./,                      reason: 'oxylabs_residential_exit_range' },
  { pattern: /^152\.233\./,                     reason: 'oxylabs_residential_exit_range' },
  // Oxylabs shared ISP pool (isp.oxylabs.io) exits on datacenter ASNs
  // (NetEnterprise AS11563, CenturyLink AS3561, EGIHosting AS32444) per live
  // audit 2026-05-21. Oxylabs Dedicated ISP (disp.oxylabs.io) exits on
  // Comcast (AS33667) and is viable for LinkedIn; do NOT retire it here.
  { pattern: /(^|\.)isp\.oxylabs\.io$/i,        reason: 'oxylabs_shared_isp_serves_datacenter' },
];
// Port-only signal: 7777 is the Oxylabs Residential rotating port across
// every gateway hostname they expose. Matching by port catches CIDR drift.
const RETIRED_PROVIDER_PORTS: Record<number, string> = {
  7777: 'oxylabs_residential_rotating_port',
};

export function retiredProviderReason(host: string | undefined, port: number | string | undefined): string | undefined {
  const portNum = typeof port === 'string' ? Number(port) : port;
  if (portNum && RETIRED_PROVIDER_PORTS[portNum]) return RETIRED_PROVIDER_PORTS[portNum];
  if (host) {
    for (const { pattern, reason } of RETIRED_PROVIDER_HOSTS) if (pattern.test(host)) return reason;
  }
  return undefined;
}

export function isProviderBlockedForPlatform(provider: string | undefined, platform: string | undefined): boolean {
  if (!provider || !platform) return false;
  return (PROVIDER_PLATFORM_BLOCK[provider] ?? []).includes(platform);
}

// Signup-specific burned exits from the 2026-06-23 Chrome-vs-Weles A/B
// diagnosis. These are intentionally NOT global LinkedIn burns: existing
// account sessions can still be healthy on an exit that cold signup challenges.
// Apply only when the current runner is linkedin_register.
const LINKEDIN_SIGNUP_CHALLENGE_EXITS: Record<string, string> = {
  // Decodo ISP: Chrome and Weles both hit captcha_gauntlet on createAccount.
  '23.26.170.193': 'linkedin_signup_ab_challenge_decodo_2026_06_23',
  // Decodo ISP extra static ports audited 2026-06-24: cold /signup probe
  // returns challenge on every attempt, before browser launch.
  '82.21.167.146': 'linkedin_signup_probe_challenge_decodo_10002_2026_06_24',
  '48.44.47.67': 'linkedin_signup_probe_challenge_decodo_10003_2026_06_24',
  // Oxylabs Dedicated ISP ports 8001-8005: all challenged in Chrome and Weles.
  '135.132.88.221': 'linkedin_signup_ab_challenge_oxylabs_dedicated_8001_2026_06_23',
  '135.132.88.223': 'linkedin_signup_ab_challenge_oxylabs_dedicated_8002_2026_06_23',
  '135.132.89.213': 'linkedin_signup_ab_challenge_oxylabs_dedicated_8003_2026_06_23',
  '135.132.90.216': 'linkedin_signup_ab_challenge_oxylabs_dedicated_8004_2026_06_23',
  '135.132.91.205': 'linkedin_signup_ab_challenge_oxylabs_dedicated_8005_2026_06_23',
  // Oxylabs Mobile A/B: challenge/inconclusive, not usable for signup.
  '108.30.70.246': 'linkedin_signup_ab_challenge_oxylabs_mobile_2026_06_23',
  '96.224.56.203': 'linkedin_signup_ab_challenge_oxylabs_mobile_2026_06_23',
};

export function isLinkedinSignupContext(): boolean {
  const label = `${process.env.ACTION ?? ''} ${process.env.WELES_LABEL ?? ''} ${process.env.WELES_PROXY_DIAGNOSTICS_LABEL ?? ''}`;
  return /\blinkedin_register\b/.test(label);
}

export function isLinkedinWarmedSignupExperiment(): boolean {
  return isLinkedinSignupContext() &&
    process.env.LINKEDIN_REGISTER_ALLOW_WARMED_SIGNUP_EXIT === '1' &&
    !!process.env.LINKEDIN_REGISTER_WARM_PROFILE_DIR;
}

export function linkedinSignupExitBurnReason(exitIp: string | undefined): string | undefined {
  if (!exitIp || !isLinkedinSignupContext()) return undefined;
  // Explicit warm-signup experiment override. This is intentionally gated on a
  // supplied warm profile dir so a normal cold linkedin_register cannot
  // accidentally burn known challenged exits.
  if (isLinkedinWarmedSignupExperiment()) return undefined;
  return LINKEDIN_SIGNUP_CHALLENGE_EXITS[exitIp];
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

// Reputation-check an exit IP via ip-api.coms free `proxy` and `hosting`
// fields. Verified 2026-05-04 against the Oxylabs sticky 4691193 exit IP
// (108.28.42.110) that produced a healthy /feed PASS at 03:51:23 — ip-api
// reported proxy:false, hosting:false, as:AS701 Verizon Business, matching
// its actual residential FiOS upstream. ip-api flags datacenter ASNs and
// known proxy exits with proxy:true or hosting:true. Pre-bind reputation
// rejection cuts the wasted Chromium boot we'd otherwise burn on a flagged
// exit before the post-goto form-render probe catches it.
export type ReputationResult = 'clean' | 'proxy' | 'hosting' | 'mobile' | 'unknown';
export interface ExitReputation {
  result: ReputationResult;
  country?: string; countryCode?: string; region?: string; city?: string;
  lat?: number; lon?: number; timezone?: string;
  isp?: string; org?: string; as?: string; asname?: string; reverse?: string;
  proxy?: boolean; hosting?: boolean; mobile?: boolean;
}
// Full exit-IP enrichment via ip-api.com (free tier). Returns the derived
// reputation `result` (proxy/hosting/mobile flags collapsed) AND the raw
// geo/ASN/ISP/reverse-DNS fields so the exact exit identity is recorded.
// `result` is what callers gate on; the rest is provenance stored per run.
export async function verifyExitReputation(exitIp: string): Promise<ExitReputation> {
  if (!exitIp) return { result: 'unknown' };
  try {
    const fields = 'status,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,asname,reverse,mobile,proxy,hosting';
    const r = await fetch(`http://ip-api.com/json/${exitIp}?fields=${fields}`);
    const j = (await r.json()) as Record<string, any>;
    if (j?.status !== 'success') return { result: 'unknown' };
    const result: ReputationResult = j.proxy === true ? 'proxy' : j.hosting === true ? 'hosting' : j.mobile === true ? 'mobile' : 'clean';
    return {
      result,
      country: j.country, countryCode: j.countryCode, region: j.regionName, city: j.city,
      lat: j.lat, lon: j.lon, timezone: j.timezone,
      isp: j.isp, org: j.org, as: j.as, asname: j.asname, reverse: j.reverse,
      proxy: j.proxy, hosting: j.hosting, mobile: j.mobile,
    };
  } catch {
    return { result: 'unknown' };
  }
}

// LinkedIn register edge-classifier probe. This must hit the same surface as
// the register trajectory: /signup with browser navigation headers. /login is
// only a loose IP-trust hint and can false-positive for registration.
export {
  probeLinkedinSignup,
  verifyTikTokRouting,
  type LinkedInProbePersona,
  type LinkedInProbeResult,
  type RoutingResult,
} from './quality/platform_probes.js';


// Event-driven topup enqueue triggered by 407 on gateway preflight CONNECT.
// Cited 2026-05-04: IPRoyal, Pingproxies, BrightData all return HTTP 407
// from gateway CONNECT when the account is unfunded or suspended. Same
// credential drives every sticky, so all retries hit the same 407 — making
// 407 a deterministic signal that the topup trajectory needs to run NOW.
const _enqueuedTopupThisProcess = new Set<string>();
const _TOPUP_SLUG: Record<string, string> = {
  'Bright Data': 'brightdata', 'PacketStream': 'packetstream',
  // Oxylabs Residential + Mobile use the same trajectory; topup.mjs now
  // probes the current active plan tier and exits PASS-NOOP without
  // charging if the user is already at-or-above the requested tier
  // (currentRank >= requestedRank check). Default topup_usd: 30 maps to
  // Starter, so an existing Starter+ subscription no-ops on 407 — preventing
  // duplicate purchases. Real tier upgrades require explicit topup_usd raise.
  'Oxylabs Residential': 'oxylabs', 'Oxylabs Mobile': 'oxylabs',
  'IPRoyal Residential': 'iproyal', 'IPRoyal Mobile': 'iproyal',
  // Pingproxies excluded until byteful React onClick swallow on
  // "Add store credit" is fixed; topup.mjs can't fire the Stripe POST today.
};
export async function enqueueProviderTopup(displayName: string): Promise<{ ok: boolean; reason?: string }> {
  if (_enqueuedTopupThisProcess.has(displayName)) return { ok: false, reason: 'already_enqueued_this_process' };
  const slug = _TOPUP_SLUG[displayName];
  if (!slug) return { ok: false, reason: 'no_slug' };
  try {
    const jobId = enqueueAction(`${slug}_topup`, '', {
      topup_usd: 30,
      topup_confirm: true,
      batch: 'auto-407-recovery',
    });
    _enqueuedTopupThisProcess.add(displayName);
    console.log(`[topup-recovery] 407 on ${displayName} -> Stado job ${jobId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.slice(0, 80) : String(error).slice(0, 80),
    };
  }
}
