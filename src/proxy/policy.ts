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

// Reputation-check an exit IP via ip-api.coms free `proxy` and `hosting`
// fields. Verified 2026-05-04 against the Oxylabs sticky 4691193 exit IP
// (108.28.42.110) that produced a healthy /feed PASS at 03:51:23 — ip-api
// reported proxy:false, hosting:false, as:AS701 Verizon Business, matching
// its actual residential FiOS upstream. ip-api flags datacenter ASNs and
// known proxy exits with proxy:true or hosting:true. Pre-bind reputation
// rejection cuts the wasted Chromium boot we'd otherwise burn on a flagged
// exit before the post-goto form-render probe catches it.
export type ReputationResult = 'clean' | 'proxy' | 'hosting' | 'mobile' | 'unknown';
export async function verifyExitReputation(exitIp: string): Promise<{ result: ReputationResult; as?: string; asname?: string; reverse?: string }> {
  if (!exitIp) return { result: 'unknown' };
  try {
    const r = await fetch(`http://ip-api.com/json/${exitIp}?fields=status,proxy,hosting,mobile,as,asname,reverse`);
    const j = (await r.json()) as { status?: string; proxy?: boolean; hosting?: boolean; mobile?: boolean; as?: string; asname?: string; reverse?: string };
    if (j?.status !== 'success') return { result: 'unknown' };
    const meta = { as: j.as, asname: j.asname, reverse: j.reverse };
    if (j.proxy === true) return { result: 'proxy', ...meta };
    if (j.hosting === true) return { result: 'hosting', ...meta };
    if (j.mobile === true) return { result: 'mobile', ...meta };
    return { result: 'clean', ...meta };
  } catch {
    return { result: 'unknown' };
  }
}

// LinkedIn edge-classifier probe. Cited from 2026-05-04 8-sticky test:
// LinkedIn returns ~52KB body containing name="session_key" when its
// anti-bot path lets the request through; ~411-505KB body without form
// markers when the anti-bot path serves the PerimeterX/reCAPTCHA challenge
// page. Same exit IP that returns the form to plain curl returns the
// challenge page to curl-with-Chrome-headers, so the probe MUST send the
// same UA + sec-ch-ua headers Chromium sends — otherwise we false-positive
// on stickies that pass plain curl but fail Chromium.
export type LinkedInProbeResult = 'form' | 'challenge' | 'unknown';
export async function probeLinkedinLogin(proxyUrl: string, secs = 8): Promise<{ result: LinkedInProbeResult; bytes?: number }> {
  if (!proxyUrl) return { result: 'unknown' };
  try {
    const { execSync } = await import('node:child_process');
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
    const args = ['-s', '--max-time', String(secs), '-x', proxyUrl,
      '-H', `User-Agent: ${ua}`,
      '-H', 'sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      '-H', 'sec-ch-ua-mobile: ?0', '-H', 'sec-ch-ua-platform: "macOS"',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      'https://www.linkedin.com/login'];
    const body = execSync(`curl ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const bytes = body.length;
    if (/name="session_key"|id="username"|input type="email"/.test(body)) return { result: 'form', bytes };
    return { result: 'challenge', bytes };
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
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return { ok: false, reason: 'no_supabase_env' };
  let accountId = '';
  try {
    const r = await fetch(`${url}/rest/v1/social_accounts?platform=eq.github&is_active=eq.true&select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json() as Array<{ id: string }>;
    accountId = rows[0]?.id ?? '';
  } catch {}
  if (!accountId) return { ok: false, reason: 'no_service_account' };
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
