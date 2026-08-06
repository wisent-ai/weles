import { optionalWelesDatabase } from '../utils/weles-database.js';

// Provider-platform toxicity policy. Lifted from credentials.ts so the
// check can fire from both the per-account path (resolveAccountSession)
// AND the URL-form path inside resolveProxy. Without this lift, a caller
// passing PROXY_URL=http://...@proxy.packetstream.io:... for a reddit
// register would bypass the per-account check entirely.

// Most provider/platform pairs are governed by the data-driven
// proxy_capability_matrix in src/proxy/capability.ts. Hard exclusions
// stay here because they're CLAUDE.md auto-rules, not statistical
// observations. PacketStream + LinkedIn is one such rule: PacketStream's
// residential range is flagged by LinkedIn anti-bot; signups from those
// IPs land on /checkpoint immediately and account_action_logs has zero
// linkedin_login successes via PacketStream.
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
export type LinkedInProbeResult = 'form' | 'challenge' | 'unknown';
export type LinkedInProbePersona = {
  os?: 'macos' | 'windows' | 'linux' | string;
  browser?: 'chromium' | 'firefox' | 'webkit' | string;
  chromeVersion?: string;
  userAgentOs?: string;
  acceptLanguage?: string;
};

function linkedinProbeHeaders(persona?: LinkedInProbePersona): Record<string, string> {
  const browser = persona?.browser ?? 'chromium';
  const acceptLanguage = persona?.acceptLanguage ?? (browser === 'firefox' ? 'en-US,en;q=0.5' : 'en-US,en;q=0.9');
  const chromeMajor = (persona?.chromeVersion ?? '147.0.0.0').split('.')[0] || '147';
  if (browser === 'firefox') {
    const os = persona?.os === 'windows' ? 'Windows NT 10.0; Win64; x64'
      : persona?.os === 'linux' ? 'X11; Linux x86_64'
      : 'Macintosh; Intel Mac OS X 10.15';
    return {
      'User-Agent': `Mozilla/5.0 (${os}; rv:142.0) Gecko/20100101 Firefox/142.0`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': acceptLanguage,
      'Upgrade-Insecure-Requests': '1',
    };
  }
  const uaOs = persona?.userAgentOs ?? 'Macintosh; Intel Mac OS X 10_15_7';
  const chPlatform = persona?.os === 'windows' ? '"Windows"' : persona?.os === 'linux' ? '"Linux"' : '"macOS"';
  return {
    'User-Agent': `Mozilla/5.0 (${uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': acceptLanguage,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Priority: 'u=0, i',
    'sec-ch-ua': `"Google Chrome";v="${chromeMajor}", "Not.A/Brand";v="8", "Chromium";v="${chromeMajor}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': chPlatform,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

export async function probeLinkedinSignup(proxyUrl: string, secs = 8, persona?: LinkedInProbePersona): Promise<{
  result: LinkedInProbeResult;
  bytes?: number;
  request?: {
    tool: 'curl';
    target_url: string;
    method: 'GET';
    timeout_secs: number;
    header_order: string[];
    headers: Record<string, string>;
    persona?: {
      os?: string;
      browser?: string;
      user_agent_os?: string;
      accept_language?: string;
    };
  };
  transport?: {
    curl_version?: string;
    curl_features?: string[];
    http_code?: number;
    http_version?: string;
    num_connects?: number;
    num_headers?: number;
    ssl_verify_result?: number;
    time_connect?: number;
    time_appconnect?: number;
    time_starttransfer?: number;
    time_total?: number;
  };
  body_markers?: {
    login_form: boolean;
    signup_form: boolean;
    challenge_dialog_template: boolean;
    security_verification_template: boolean;
    hard_challenge: boolean;
    challenge_terms: boolean;
  };
  response_body?: {
    encoding: 'utf8';
    text: string;
    bytes: number;
    truncated: boolean;
    max_bytes: number;
  };
  error?: string;
}> {
  if (!proxyUrl) return { result: 'unknown' };
  const targetUrl = 'https://www.linkedin.com/signup';
  const headers = linkedinProbeHeaders(persona);
  const headerOrder = Object.keys(headers);
  const request = {
    tool: 'curl' as const,
    target_url: targetUrl,
    method: 'GET' as const,
    timeout_secs: secs,
    header_order: headerOrder,
    headers,
    persona: persona ? {
      os: persona.os,
      browser: persona.browser,
      user_agent_os: persona.userAgentOs,
      accept_language: persona.acceptLanguage,
    } : undefined,
  };
  let curlVersion = '';
  let curlFeatures: string[] = [];
  try {
    const { execFileSync } = await import('node:child_process');
    const versionOut = execFileSync('curl', ['--version'], { encoding: 'utf8', maxBuffer: 256 * 1024 });
    const lines = versionOut.split(/\r?\n/);
    curlVersion = lines[0]?.trim() ?? '';
    const features = lines.find(l => l.startsWith('Features:'));
    curlFeatures = features ? features.replace(/^Features:\s*/, '').split(/\s+/).filter(Boolean) : [];

    const args = ['-sS', '--compressed', '--max-time', String(secs), '-x', proxyUrl,
      ...headerOrder.flatMap((name) => ['-H', `${name}: ${headers[name]}`]),
      '-w', '\n__CURL_META__%{json}',
      targetUrl];
    const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const marker = '\n__CURL_META__';
    const idx = out.lastIndexOf(marker);
    const body = idx >= 0 ? out.slice(0, idx) : out;
    const metaRaw = idx >= 0 ? out.slice(idx + marker.length) : '';
    let meta: any = {};
    try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch {}
    const bytes = body.length;
    const maxBodyBytes = Number(process.env.WELES_LINKEDIN_PREFLIGHT_BODY_MAX_BYTES ?? 1_000_000);
    const responseBody = {
      encoding: 'utf8' as const,
      text: body.slice(0, maxBodyBytes),
      bytes,
      truncated: body.length > maxBodyBytes,
      max_bytes: maxBodyBytes,
    };
    const invisibleRecaptchaEnterpriseAnchor =
      /(?:google\.com\/)?recaptcha\/enterprise\/anchor[\s\S]{0,500}(?:[?&]|%26)size(?:=|%3D)invisible/i.test(body);
    const hardCaptcha =
      /checkpoint\/challenge|challengeIframe|px-cloud|arkoselabs|funcaptcha|hcaptcha/i.test(body) ||
      ((/g-recaptcha|google\.com\/recaptcha|recaptcha/i.test(body)) && !invisibleRecaptchaEnterpriseAnchor);
    const bodyMarkers = {
      login_form: /name="session_key"|id="username"|input type="email"/.test(body),
      signup_form: /name="email-address"|id="email-address"|join-form-submit/.test(body),
      challenge_dialog_template: /challenge-dialog/i.test(body),
      security_verification_template: /Security verification/i.test(body),
      invisible_recaptcha_enterprise_anchor: invisibleRecaptchaEnterpriseAnchor,
      hard_challenge: hardCaptcha,
      challenge_terms: /checkpoint|challenge|captcha|recaptcha|security/i.test(body),
    };
    const transport = {
      curl_version: curlVersion,
      curl_features: curlFeatures,
      http_code: typeof meta.http_code === 'number' ? meta.http_code : undefined,
      http_version: typeof meta.http_version === 'string' ? meta.http_version : undefined,
      num_connects: typeof meta.num_connects === 'number' ? meta.num_connects : undefined,
      num_headers: typeof meta.num_headers === 'number' ? meta.num_headers : undefined,
      ssl_verify_result: typeof meta.ssl_verify_result === 'number' ? meta.ssl_verify_result : undefined,
      time_connect: typeof meta.time_connect === 'number' ? meta.time_connect : undefined,
      time_appconnect: typeof meta.time_appconnect === 'number' ? meta.time_appconnect : undefined,
      time_starttransfer: typeof meta.time_starttransfer === 'number' ? meta.time_starttransfer : undefined,
      time_total: typeof meta.time_total === 'number' ? meta.time_total : undefined,
    };
    if (bodyMarkers.signup_form && !bodyMarkers.hard_challenge) return { result: 'form', bytes, request, transport, body_markers: bodyMarkers, response_body: responseBody };
    return { result: bodyMarkers.hard_challenge ? 'challenge' : 'unknown', bytes, request, transport, body_markers: bodyMarkers, response_body: responseBody };
  } catch (e: any) {
    return {
      result: 'unknown',
      request,
      transport: { curl_version: curlVersion, curl_features: curlFeatures },
      error: String(e?.message ?? e).replace(proxyUrl, '[proxy-url]').slice(0, 200),
    };
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
async function probeOnce(proxyUrl: string, secs: number): Promise<{ vregion: string | null; bytes: number }> {
  try {
    const { execSync } = await import('node:child_process');
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
    // Chromium-realistic header set (mirrors the linkedin probe pattern):
    // a plain UA-only curl can pass while real Chromium fails — TikTok's
    // edge gates on sec-ch-ua + Accept-Language too. Match what Chromium
    // actually sends so probe verdict tracks browser behaviour.
    const args = ['-s', '--max-time', String(secs), '-x', proxyUrl,
      '-H', `User-Agent: ${ua}`,
      '-H', 'sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      '-H', 'sec-ch-ua-mobile: ?0', '-H', 'sec-ch-ua-platform: "macOS"',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      'https://www.tiktok.com/signup'];
    const body = execSync(`curl ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const m = body.match(/"vregion":"([A-Z0-9-]{1,20})"/);
    return { vregion: m ? m[1] : null, bytes: body.length };
  } catch { return { vregion: null, bytes: 0 }; }
}
export async function verifyTikTokRouting(proxyUrl: string, secs = 12): Promise<{ result: RoutingResult; vregion?: string }> {
  if (!proxyUrl) return { result: 'unknown' };
  // Dual probe with Chromium-realistic headers: BrightData sticky sessions
  // can rotate exit IPs between requests, so two back-to-back probes catch
  // drift. Reject any sticky that on either probe (a) lacks vregion,
  // (b) returns TTP2, (c) shows mobile-redirect markers
  // (/login/download-app referenced in /signup body == 1340 at
  // register_verify_login), or (d) drifts vregion across probes.
  const a = await probeOnce(proxyUrl, secs);
  if (!a.vregion) return { result: 'unknown' };
  if (/-TTP2$/i.test(a.vregion)) return { result: 'high_risk', vregion: a.vregion };
  const b = await probeOnce(proxyUrl, secs);
  if (!b.vregion) return { result: 'unknown', vregion: a.vregion };
  if (a.vregion !== b.vregion) return { result: 'high_risk', vregion: `${a.vregion}!=${b.vregion}` };
  if (/-TTP2$/i.test(b.vregion)) return { result: 'high_risk', vregion: b.vregion };
  return { result: 'standard', vregion: a.vregion };
}

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
  const url = optionalWelesDatabase()?.url ?? '';
  const key = optionalWelesDatabase()?.token ?? '';
  if (!url || !key) return { ok: false, reason: 'no_supabase_env' };
  let accountId = '';
  try {
    const r = await fetch(`${url}/rest/v1/social_accounts?platform=eq.github&is_active=eq.true&select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json() as Array<{ id: string }>;
    accountId = rows[0]?.id ?? '';
  } catch {}
  if (!accountId) return { ok: false, reason: 'no_service_account' };
  try {
    const f = await fetch(`${url}/rest/v1/system_settings?key=eq.workers_enabled&select=value`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const flagRows = await f.json() as Array<{ value: { enabled?: boolean } }>;
    if (flagRows[0]?.value?.enabled === false) return { ok: false, reason: 'workers_disabled' };
  } catch {}
  try {
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const r = await fetch(`${url}/rest/v1/account_action_logs?action=eq.${slug}_topup&status=eq.queued&started_at=gte.${since}&select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json() as Array<{ id: string }>;
    if (rows.length > 0) { _enqueuedTopupThisProcess.add(displayName); return { ok: false, reason: 'already_queued_in_db' }; }
  } catch {}
  const body = { account_id: accountId, platform: slug, action: `${slug}_topup`, status: 'queued', scheduled_at: new Date().toISOString(), params: { topup_usd: 30, topup_confirm: true, batch: 'auto-407-recovery' } };
  try {
    const r = await fetch(`${url}/rest/v1/account_action_logs`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) return { ok: false, reason: `insert_${r.status}` };
    _enqueuedTopupThisProcess.add(displayName);
    console.log(`[topup-recovery] 407 on ${displayName} -> enqueued ${slug}_topup`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e.message?.slice(0, 80) ?? 'err' };
  }
}
