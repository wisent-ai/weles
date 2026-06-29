// ---------------------------------------------------------------------------
// ProxyConfig interface & helpers
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { runRecordingsDir } from '../session/run-recordings.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LinkedInProbePersona } from './policy.js';

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

type ProxyPreflightAttempt = {
  provider?: string;
  display_name: string;
  proxy_type: string;
  country: string;
  endpoint: { host: string; port: string };
  sticky_hash: string;
  connect_status?: number;
  exit_ip_hash?: string;
  exit_ip_present?: boolean;
  geo_result?: string;
  geo_exit_cc?: string;
  linkedin_probe_result?: string;
  linkedin_probe_bytes?: number;
  linkedin_probe_request?: unknown;
  linkedin_probe_transport?: unknown;
  linkedin_probe_body_markers?: unknown;
  linkedin_probe_response_body?: unknown;
  linkedin_probe_error?: string;
  tiktok_route_result?: string;
  tiktok_vregion_present?: boolean;
  rejected_reason?: string;
};

function diagHash(value: unknown): string | undefined {
  const text = String(value ?? '');
  if (!text) return undefined;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function proxyPreflightDir(): string | undefined {
  const label = process.env.WELES_PROXY_DIAGNOSTICS_LABEL || process.env.WELES_LABEL;
  if (!label) return undefined;
  const dir = runRecordingsDir(label); // G17: recordings/<run_uuid>/<label>/proxy_preflight.json
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeProxyPreflightDiagnostics(diag: Record<string, unknown>): void {
  try {
    const dir = proxyPreflightDir();
    if (!dir) return;
    writeFileSync(join(dir, 'proxy_preflight.json'), JSON.stringify({
      ...diag,
      redaction: {
        proxy_credentials: 'omitted',
        sticky_ids: 'sha256-prefix only',
        exit_ips: 'sha256-prefix only',
        linkedin_probe: 'request headers, curl transport metadata, and unauthenticated response bodies captured; proxy credentials omitted',
      },
    }, null, 2));
  } catch {}
}

function platformFromTarget(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const h = host.toLowerCase();
  if (h.includes('instagram.com') || h.includes('threads.net')) return 'instagram';
  if (h.includes('x.com') || h.includes('twitter.com')) return 'twitter';
  if (h.includes('linkedin.com')) return 'linkedin';
  if (h.includes('reddit.com')) return 'reddit';
  if (h.includes('discord.com') || h.includes('discordapp.com')) return 'discord';
  if (h.includes('github.com')) return 'github';
  if (h.includes('tiktok.com')) return 'tiktok';
  if (h.includes('producthunt.com')) return 'producthunt';
  if (h.includes('youtube.com')) return 'youtube';
  if (h.includes('google.com')) return 'google';  // accounts.google.com etc — was undefined → legacy isBurned blocked all PacketStream LB IPs (verified 2026-05-07)
  return undefined;
}

export async function resolveProxy(proxy: string, targetHost?: string, preflightPersona?: LinkedInProbePersona): Promise<{ server: string; username?: string; password?: string; country?: string; exit_ip?: string; platform?: string; provider?: string; proxy_type?: string; sticky_session_id?: string; sticky_hash?: string; exit_reputation?: import('./policy.js').ExitReputation } | undefined> {
  if (!proxy || proxy === 'none' || proxy === 'direct') return undefined;
  const attempts: ProxyPreflightAttempt[] = [];
  const startedAt = new Date().toISOString();

  if (proxy.startsWith('http://') || proxy.startsWith('https://') || proxy.startsWith('socks')) {
    const u = new URL(proxy);
    // Toxicity policy on URL-form path: reject providers blocked for target.
    const { providerFromHost, isProviderBlockedForPlatform, retiredProviderReason } = await import('./policy.js');
    const platformForBlock = platformFromTarget(targetHost);
    const provFromUrl = providerFromHost(u.hostname, decodeURIComponent(u.username));
    const retiredReason = retiredProviderReason(u.hostname, u.port);
    // Escape hatch for RE-VALIDATION: a retire/toxic verdict is learned from a
    // point-in-time observation; a provider's underlying pool can rotate (e.g.
    // Oxylabs disp.* moved from CenturyLink datacenter ASNs to Comcast
    // residential since the 2026-05-12 block). WELES_ALLOW_RETIRED_PROXY=1
    // deliberately bypasses the URL-form blocks so such an exit can be re-tested.
    const allowRetired = process.env.WELES_ALLOW_RETIRED_PROXY === '1';
    if (allowRetired && (retiredReason || isProviderBlockedForPlatform(provFromUrl, platformForBlock))) {
      console.log(`[proxy] OVERRIDE: WELES_ALLOW_RETIRED_PROXY=1 — bypassing block for ${u.hostname}:${u.port} (would be: ${retiredReason ?? 'toxic_for_' + platformForBlock})`);
    }
    if (retiredReason && !allowRetired) {
      console.log(`[proxy] BLOCKED: PROXY_URL host=${u.hostname}:${u.port} retired=${retiredReason} — refusing to hand out`);
      writeProxyPreflightDiagnostics({
        requested_proxy: '[url-form]',
        target_host: targetHost ?? null,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        selected: false,
        failure_reason: 'retired_url_form_proxy',
        retired_reason: retiredReason,
        endpoint: { host: u.hostname, port: u.port },
      });
      return undefined;
    }
    if (isProviderBlockedForPlatform(provFromUrl, platformForBlock) && !allowRetired) {
      console.log(`[proxy] BLOCKED: PROXY_URL host=${u.hostname} maps to ${provFromUrl}, which is on the toxic list for ${platformForBlock} — refusing to hand out`);
      writeProxyPreflightDiagnostics({
        requested_proxy: '[url-form]',
        target_host: targetHost ?? null,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        selected: false,
        failure_reason: 'provider_blocked_for_platform',
        provider: provFromUrl,
        platform: platformForBlock,
        endpoint: { host: u.hostname, port: u.port },
      });
      return undefined;
    }
    return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), platform: platformForBlock, provider: provFromUrl, proxy_type: 'url_unclassified' };
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) {
    console.log('[proxy] No Supabase credentials — cannot fetch providers');
    return undefined;
  }

  // Don't gate on balance_usd > 0. The balance is auto-refreshed by the
  // *_balance.mjs trajectories which themselves break (Oxylabs dashboard
  // captcha, etc.) — stale 0 balance kicks otherwise-working providers out
  // of rotation. The credential filter (env vars present + proxy_host set)
  // is the real liveness check; an empty balance trigger falls through
  // when the provider 407s on auth.
  const res = await fetch(
    `${supabaseUrl}/rest/v1/service_credentials?category=eq.proxy&proxy_host=not.is.null&select=display_name,proxy_host,proxy_port,api_key_env_var,balance_usd,metadata&order=balance_usd.desc.nullslast`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) { console.log(`[proxy] Failed to fetch providers: ${res.status}`); return undefined; }
  type Row = { display_name: string; proxy_host: string; proxy_port: string; api_key_env_var: string; balance_usd: number; metadata?: { country?: string } };
  const providers = await res.json() as Row[];
  // Decodo first — canonical static ISP (real residential ASNs). Skip-shuffle
  // branch below keeps this order deterministic for isIsp filters.
  const { maybeOxylabsIspRow, maybeOxylabsDedicatedIspRow, maybeDecodoIspRows } = await import('./sources/isp_row.js');
  for (const r of [...maybeDecodoIspRows(), maybeOxylabsIspRow(), maybeOxylabsDedicatedIspRow()]) if (r) providers.push(r);

  const typeFilter = proxy.toLowerCase();
  // Tokens after 'residential'/'mobile' may include a 2-letter country code
  // ('residential us', 'residential br') to override the row's stored country.
  // The Oxylabs Residential row defaults to 'br' for Discord — Reddit/LinkedIn
  // need 'us'. Caller passes the country it wants instead of relying on the row.
  const ccOverride = (typeFilter.match(/\b([a-z]{2})\b/g) ?? []).find(t => !['oxylabs', 'mobile', 'residential', 'datacenter', 'sticky'].includes(t) && /^[a-z]{2}$/.test(t));
  const isResidential = /\bresidential\b/.test(typeFilter);
  const isMobile = /\bmobile\b/.test(typeFilter);
  const isIsp = /\bisp\b/.test(typeFilter);
  const proxyType = isIsp ? 'isp' : isMobile ? 'mobile' : isResidential ? 'residential' : 'unknown';
  let filtered = isIsp ? providers.filter(p => p.display_name.toLowerCase().includes('isp'))
    : isResidential ? providers.filter(p => !p.display_name.toLowerCase().includes('mobile') && !p.display_name.toLowerCase().includes('isp'))
    : isMobile ? providers.filter(p => p.display_name.toLowerCase().includes('mobile'))
    : providers;

  // Allow explicit provider name targeting (e.g. 'pingproxies', 'packetstream', 'oxylabs')
  const KNOWN_PROVIDERS = ['oxylabs', 'packetstream', 'pingproxies', 'iproyal', 'brightdata', 'decodo'];
  const explicit = KNOWN_PROVIDERS.find(n => typeFilter.includes(n));
  if (explicit) {
    // Strip spaces / underscores from display_name so 'brightdata' matches 'Bright Data'.
    filtered = filtered.filter(p => p.display_name.toLowerCase().replace(/[\s_-]+/g, '').includes(explicit));
  }

  // Shuffle residential/mobile (per-pool rate limits). ISP stays deterministic.
  if (!isIsp) for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }

  const { retiredProviderReason, isProviderBlockedForPlatform } = await import('./policy.js');
  for (const p of filtered) {
    const retiredReason = retiredProviderReason(p.proxy_host, p.proxy_port);
    if (retiredReason) {
      console.log(`[proxy] BLOCKED: ${p.display_name} host=${p.proxy_host}:${p.proxy_port} retired=${retiredReason} - skipping`);
      attempts.push({
        display_name: p.display_name,
        proxy_type: proxyType,
        country: '',
        endpoint: { host: p.proxy_host, port: String(p.proxy_port) },
        sticky_hash: '',
        rejected_reason: `retired:${retiredReason}`,
      });
      continue;
    }

    const envUser = p.api_key_env_var;
    const envPass = envUser?.replace('USERNAME', 'PASSWORD').replace('API_KEY', 'PASSWORD');
    const username = process.env[envUser] ?? '';
    const password = process.env[envPass] ?? '';
    if (!username || !password) {
      console.log(`[proxy] Skipping ${p.display_name}: missing env ${envUser}/${envPass}`);
      attempts.push({
        display_name: p.display_name,
        proxy_type: proxyType,
        country: '',
        endpoint: { host: p.proxy_host, port: String(p.proxy_port) },
        sticky_hash: '',
        rejected_reason: 'missing_env',
      });
      continue;
    }
    const { isBurned } = await import('./burned.js');
    const name = p.display_name.toLowerCase();
    const _ov = (p.metadata as any)?.country_overrides?.[platformFromTarget(targetHost) ?? ''];
    const cc = (ccOverride ?? _ov ?? p.metadata?.country ?? 'us').toLowerCase();
    // City pin: same shape as country_overrides. When set, pin the exit
    // city so persona timezone aligns with proxy geo (LinkedIn flags
    // tz/IP mismatches as suspicious-device signals).
    const _cityOv = (p.metadata as any)?.city_overrides?.[platformFromTarget(targetHost) ?? ''];
    const city = (_cityOv ?? (p.metadata as any)?.city ?? '').toString().toLowerCase().replace(/\s+/g, '_') || undefined;
    // DB-row policy enforcement: skip providers blocked for the target
    // platform regardless of how the resolver got here.
    const provKey = name.includes('packetstream') ? 'packetstream' : name.includes('pingproxies') ? 'pingproxies' : name.includes('oxylabs') ? 'oxylabs' : name.includes('iproyal') ? 'iproyal' : name.includes('bright') ? 'brightdata' : name.includes('decodo') ? 'decodo' : undefined;
    if (isProviderBlockedForPlatform(provKey, platformFromTarget(targetHost))) {
      console.log(`[proxy] BLOCKED: ${p.display_name} is on toxic list for ${platformFromTarget(targetHost)} — skipping`);
      attempts.push({
        provider: provKey,
        display_name: p.display_name,
        proxy_type: proxyType,
        country: cc,
        endpoint: { host: p.proxy_host, port: String(p.proxy_port) },
        sticky_hash: '',
        rejected_reason: 'provider_blocked_for_platform',
      });
      continue;
    }
    // 8 sticky tries for rotating/sticky providers — each fresh sessId can
    // resolve to a different exit IP. ISP rows are static per port, so one
    // attempt per row is enough; additional tries just resample the same exit.
    const maxAttempts = proxyType === 'isp' ? 1 : 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sessId = Math.floor(Math.random() * 9000000 + 1000000);
      let stickyUser = username, stickyPass = password;
      if (name.includes('oxylabs') && !name.includes('isp')) {
        const cityPart = city ? `-city-${city}` : '';
        stickyUser = `customer-${username}-cc-${cc}${cityPart}-sessid-${sessId}`;
      }
      // Oxylabs ISP: static IPs, plain username/password — no customer- prefix, no sessid.
      else if (name.includes('packetstream')) stickyPass = `${password}_country-${cc.toUpperCase()}_session-${sessId}`;
      else if (name.includes('iproyal')) stickyPass = `${password}_country-${cc}_session-${sessId}`;
      else if (name.includes('pingproxies')) stickyUser = `${username}_c_${cc}_s_${sessId}`;
      // Bright Data: zone-prefixed user, sticky session via -session- suffix.
      else if (name.includes('bright')) stickyUser = `${username}-country-${cc}-session-${sessId}`;
      let host = p.proxy_host;
      const attemptDiag: ProxyPreflightAttempt = {
        provider: provKey,
        display_name: p.display_name,
        proxy_type: proxyType,
        country: cc,
        endpoint: { host: p.proxy_host, port: String(p.proxy_port) },
        sticky_hash: diagHash(sessId) ?? '',
      };
      attempts.push(attemptDiag);
      // Pull all LB A records, filter burned, pick random survivor.
      try {
        const dns = await import('node:dns');
        const allIps: string[] = await new Promise<string[]>((res, rej) =>
          dns.resolve4(p.proxy_host, (e: any, a: string[]) => e ? rej(e) : res(a)));
        const live = [];
        // Per-platform isBurned: legacy burns (registry entries written
        // before 218e2dd) match LB IPs unconditionally with no platform tag,
        // and would filter out PacketStream entirely on every platform.
        // Pass the target platform so a burn is only respected for the same
        // platform — pre-218e2dd entries with platforms=[] become inert.
        const platformForBurn = platformFromTarget(targetHost);
        for (const ip of allIps) { if (!(await isBurned(ip, platformForBurn))) live.push(ip); }
        if (live.length === 0) {
          attemptDiag.rejected_reason = 'all_dns_answers_burned';
          continue;
        }
        host = live[Math.floor(Math.random() * live.length)];
        attemptDiag.endpoint = { host, port: String(p.proxy_port) };
      } catch {
        try { const dns = await import('node:dns'); host = await new Promise<string>((res, rej) => dns.lookup(p.proxy_host, (e: any, a: string) => e ? rej(e) : res(a))); } catch {}
        attemptDiag.endpoint = { host, port: String(p.proxy_port) };
        if (await isBurned(host, platformFromTarget(targetHost))) {
          attemptDiag.rejected_reason = 'dns_answer_burned';
          continue;
        }
      }
      // Pre-flight CONNECT + exit_ip probe (skip via PROXY_SKIP_PREFLIGHT=1).
      let exitIp = '';
      const platform = platformFromTarget(targetHost);
      if (!process.env.PROXY_SKIP_PREFLIGHT) {
        const probeHost = targetHost || 'api.ipify.org';
        let preflightContinue = false;
        try {
          const auth = Buffer.from(`${stickyUser}:${stickyPass}`).toString('base64');
          const net = await import('node:net');
          const status = await new Promise<number>((resolve) => {
            const sock = net.connect({ host, port: Number(p.proxy_port) }, () => sock.write(`CONNECT ${probeHost}:443 HTTP/1.1\r\nHost: ${probeHost}:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`));
            const timer = setTimeout(() => { sock.destroy(); resolve(-1); }, 4000);
            sock.once('data', (d) => { clearTimeout(timer); sock.destroy(); const m = /^HTTP\/1\.[01] (\d{3})/.exec(d.toString()); resolve(m ? Number(m[1]) : 0); });
            sock.once('error', () => { clearTimeout(timer); resolve(-1); });
          });
          const ok = status === 200;
          attemptDiag.connect_status = status;
          if (!ok) {
            console.log(`[proxy] Pre-flight failed ${p.display_name} sticky=${sessId} status=${status}`);
            attemptDiag.rejected_reason = `connect_status:${status}`;
            preflightContinue = true;
            // 407 = account unfunded/suspended. Same credential, all sticks fail. Enqueue topup now.
            if (status === 407) { const { enqueueProviderTopup } = await import('./policy.js'); await enqueueProviderTopup(p.display_name).catch(() => {}); break; }
          }
          else {
            // Sample exit IP for burn tracking + IPXO range filter.
            try {
              const { execSync } = await import('node:child_process');
              const proxyAuth = `http://${encodeURIComponent(stickyUser)}:${encodeURIComponent(stickyPass)}@${host}:${p.proxy_port}`;
              exitIp = execSync(`curl -s --max-time 6 -x "${proxyAuth}" https://api.ipify.org`, { encoding: 'utf8' }).trim();
            } catch (e: any) { console.log(`[proxy] exit-ip probe err: ${e.message?.slice(0, 80)}`); }
            console.log(`[proxy] sampled exit_ip="${exitIp}" sticky=${sessId}`);
            attemptDiag.exit_ip_present = !!exitIp;
            attemptDiag.exit_ip_hash = diagHash(exitIp);
            if (exitIp && /^82\.40\./.test(exitIp)) { console.log(`[proxy] Skipping IPXO exit ${exitIp}`); attemptDiag.rejected_reason = 'ipxo_exit'; preflightContinue = true; }
            else if (exitIp && platform && (await isBurned(exitIp, platform))) {
              console.log(`[proxy] Exit ${exitIp} already burned for ${platform} — rerolling sticky`);
              attemptDiag.rejected_reason = 'exit_ip_burned';
              preflightContinue = true;
            }
            if (!preflightContinue && exitIp && platform === 'linkedin') {
              const { linkedinSignupExitBurnReason } = await import('./policy.js');
              const signupBurnReason = linkedinSignupExitBurnReason(exitIp);
              if (signupBurnReason) {
                console.log(`[proxy] LinkedIn signup exit ${exitIp} is known-challenged (${signupBurnReason}) — rerolling sticky`);
                attemptDiag.rejected_reason = signupBurnReason;
                preflightContinue = true;
              }
            }
            // Country + LinkedIn register probe. The LinkedIn gate must test
            // /signup, not /login, because login-form access can false-positive
            // for register runs.
            if (!preflightContinue && exitIp) {
              const { verifyExitCountry, probeLinkedinSignup } = await import('./policy.js');
              const geo = cc ? await verifyExitCountry(exitIp, cc) : { result: 'unknown' as const };
              attemptDiag.geo_result = geo.result;
              attemptDiag.geo_exit_cc = geo.exitCc;
              if (geo.result === 'mismatch') { attemptDiag.rejected_reason = 'geo_mismatch'; preflightContinue = true; }
              if (!preflightContinue && platform === 'linkedin') {
                const { isLinkedinWarmedSignupExperiment } = await import('./policy.js');
                if (isLinkedinWarmedSignupExperiment()) {
                  console.log(`[proxy] linkedin-probe skipped for warmed signup profile exit=${exitIp}`);
                  attemptDiag.linkedin_probe_result = 'skipped_warm_profile';
                } else {
                  const url = `http://${encodeURIComponent(stickyUser)}:${encodeURIComponent(stickyPass)}@${host}:${p.proxy_port}`;
                  const probe = await probeLinkedinSignup(url, 8, preflightPersona);
                  console.log(`[proxy] linkedin-probe exit=${exitIp} -> ${probe.result}${probe.bytes ? ` (${probe.bytes}B)` : ''}`);
                  attemptDiag.linkedin_probe_result = probe.result;
                  attemptDiag.linkedin_probe_bytes = probe.bytes;
                  attemptDiag.linkedin_probe_request = probe.request;
                  attemptDiag.linkedin_probe_transport = probe.transport;
                  attemptDiag.linkedin_probe_body_markers = probe.body_markers;
                  attemptDiag.linkedin_probe_response_body = probe.response_body;
                  attemptDiag.linkedin_probe_error = probe.error;
                  if (probe.result !== 'form') {
                    attemptDiag.rejected_reason = `linkedin_probe:${probe.result}`;
                    preflightContinue = true;
                  }
                }
              }
            }
            // TikTok-specific: require US-TTP standard cluster. Reject
            // both US-TTP2 (high-risk) and unknown (probe flake) — the
            // trajectory cannot recover from a TTP2 page bootstrap.
            if (!preflightContinue && platform === 'tiktok') {
              const { verifyTikTokRouting } = await import('./policy.js');
              const proxyUrl = `http://${encodeURIComponent(stickyUser)}:${encodeURIComponent(stickyPass)}@${host}:${p.proxy_port}`;
              const route = await verifyTikTokRouting(proxyUrl);
              console.log(`[proxy] tiktok-route exit=${exitIp} -> ${route.result}${route.vregion ? ` (${route.vregion})` : ''}`);
              attemptDiag.tiktok_route_result = route.result;
              attemptDiag.tiktok_vregion_present = !!route.vregion;
              if (route.result !== 'standard') {
                console.log(`[proxy] TikTok routing not standard (${route.result}${route.vregion ? `=${route.vregion}` : ''}) — rerolling sticky`);
                attemptDiag.rejected_reason = `tiktok_route:${route.result}`;
                preflightContinue = true;
              }
            }
          }
        } catch { /* skip preflight on unexpected error, return as-is */ }
        if (preflightContinue) continue;
      }
      console.log(`[proxy] Using: ${p.display_name} (${host}:${p.proxy_port}, $${p.balance_usd}, sticky=${sessId}, exit=${exitIp || '?'})`);
      // G11: enrich the winning exit IP once via ip-api (ASN/ISP/org/reverse/
      // geo + proxy/hosting/mobile flags). One call per successful resolve;
      // attached to the returned proxy config so it lands in
      // result.session.exit_reputation, and into the preflight storage backup.
      let exitReputation: import('./policy.js').ExitReputation | undefined;
      if (exitIp) {
        try {
          const { verifyExitReputation } = await import('./policy.js');
          exitReputation = await verifyExitReputation(exitIp);
          console.log(`[proxy] exit reputation ${exitIp} -> ${exitReputation.result}${exitReputation.asname ? ` ${exitReputation.asname}` : ''}`);
        } catch (e: any) { console.log(`[proxy] exit reputation err: ${e?.message?.slice(0, 80)}`); }
      }
      writeProxyPreflightDiagnostics({
        requested_proxy: proxy.startsWith('http') ? '[url-form]' : proxy,
        target_host: targetHost ?? null,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        selected: true,
        selected_provider: p.display_name,
        selected_endpoint: { host, port: String(p.proxy_port) },
        selected_exit_ip_hash: diagHash(exitIp),
        selected_exit_reputation: exitReputation,
        attempt_count: attempts.length,
        attempts,
      });
      // G4: expose the chosen sticky session id (raw sessId) and its diag hash
      // so the run row records which sticky exit the session pinned to. Only
      // sticky-capable providers reach this success path with a sessId; the
      // field is legitimately undefined for non-sticky/url-form proxies.
      return { server: `http://${host}:${p.proxy_port}`, username: stickyUser, password: stickyPass, country: cc, exit_ip: exitIp || undefined, platform, provider: provKey, proxy_type: proxyType, sticky_session_id: String(sessId), sticky_hash: diagHash(sessId), exit_reputation: exitReputation };
    }
  }

  console.log(`[proxy] No working provider found for type="${proxy}"`);
  writeProxyPreflightDiagnostics({
    requested_proxy: proxy.startsWith('http') ? '[url-form]' : proxy,
    target_host: targetHost ?? null,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    selected: false,
    failure_reason: 'no_working_provider',
    attempt_count: attempts.length,
    attempts,
  });
  return undefined;
}
