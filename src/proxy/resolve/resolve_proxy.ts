// Resolve a proxy request into one working exit: a URL is honoured as given,
// a type word is tried against the provider rows in order, and each sticky
// attempt is put through the exit preflight before it is returned.
import type { ExitReputation, LinkedInProbePersona } from '../policy.js';
import type { ResolvedProxy } from '../config.js';
import { PROXY_SECRET_SERVICE_BY_DISPLAY_NAME } from '../config.js';
import { readOptionalWelesServiceSecret } from '../../secrets/scoped-service.js';
import { providerCandidates } from './candidates.js';
import { diagHash, platformFromTarget, writeProxyPreflightDiagnostics, type ProxyPreflightAttempt } from './diagnostics.js';
import { preflightExit } from './exit_preflight.js';
import { resolveUrlFormProxy } from './url_form.js';

export async function resolveProxy(proxy: string, targetHost?: string, preflightPersona?: LinkedInProbePersona): Promise<ResolvedProxy | undefined> {
  if (!proxy || proxy === 'none' || proxy === 'direct') return undefined;
  const attempts: ProxyPreflightAttempt[] = [];
  const startedAt = new Date().toISOString();

  if (proxy.startsWith('http://') || proxy.startsWith('https://') || proxy.startsWith('socks')) {
    return resolveUrlFormProxy(proxy, targetHost, startedAt);
  }

  const { candidates: filtered, proxyType, ccOverride } = await providerCandidates(proxy);

  const { retiredProviderReason, isProviderBlockedForPlatform } = await import('../policy.js');
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

    const secretService = p.secret_service ?? PROXY_SECRET_SERVICE_BY_DISPLAY_NAME[p.display_name];
    const username = secretService ? readOptionalWelesServiceSecret(secretService, 'username') ?? '' : '';
    const password = secretService ? readOptionalWelesServiceSecret(secretService, 'password') ?? '' : '';
    if (!secretService || !username || !password) {
      console.log(`[proxy] Skipping ${p.display_name}: exact provider grant unavailable`);
      attempts.push({
        display_name: p.display_name,
        proxy_type: proxyType,
        country: '',
        endpoint: { host: p.proxy_host, port: String(p.proxy_port) },
        sticky_hash: '',
        rejected_reason: secretService ? 'missing_exact_provider_grant' : 'unscoped_provider',
      });
      continue;
    }
    const { isBurned } = await import('../burned.js');
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
      const platform = platformFromTarget(targetHost);
      const verdict = await preflightExit({
        host, port: String(p.proxy_port), stickyUser, stickyPass, cc, platform, targetHost,
        displayName: p.display_name, sessId, preflightPersona, attemptDiag, isBurned,
      });
      if (verdict.abandonProvider) break;
      if (verdict.rejected) continue;
      const exitIp = verdict.exitIp;
      console.log(`[proxy] Using: ${p.display_name} (${host}:${p.proxy_port}, $${p.balance_usd}, sticky=${sessId}, exit=${exitIp || '?'})`);
      // G11: enrich the winning exit IP once via ip-api (ASN/ISP/org/reverse/
      // geo + proxy/hosting/mobile flags). One call per successful resolve;
      // attached to the returned proxy config so it lands in
      // result.session.exit_reputation, and into the preflight storage backup.
      let exitReputation: ExitReputation | undefined;
      if (exitIp) {
        try {
          const { verifyExitReputation } = await import('../policy.js');
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
      return { server: `http://${host}:${p.proxy_port}`, username: stickyUser, password: stickyPass, country: cc, city, exit_ip: exitIp || undefined, platform, provider: provKey, proxy_type: proxyType, sticky_session_id: String(sessId), sticky_hash: diagHash(sessId), exit_reputation: exitReputation };
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
