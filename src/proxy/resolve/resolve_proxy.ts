// Resolve a proxy request into one working exit: a URL is honoured as given,
// a pool request is tried against the provider rows in order, one sticky
// attempt per row, and each attempt is put through the exit preflight before
// it is returned. The exit's country is the request's, else the row's
// override for the target platform, else the row's own; a row for which none
// is stated is skipped by name instead of being given a country.
import { lookup, resolve4 } from 'node:dns/promises';
import type { ExitReputation, LinkedInProbePersona } from '../policy.js';
import type { ResolvedProxy } from '../config.js';
import { readOptionalWelesServiceSecret } from '../../secrets/scoped-service.js';
import {
  secretServiceFor,
  stickyCredentials,
} from '../sources/provider_credentials.js';
import { providerCandidates, type ProviderRow } from './candidates.js';
import {
  diagHash,
  platformFromTarget,
  writeProxyPreflightDiagnostics,
  type ProxyPreflightAttempt,
} from './diagnostics.js';
import { preflightExit } from './exit_preflight.js';
import {
  requestsNoProxy,
  requestsUrlForm,
  resolveUrlFormProxy,
} from './url_form.js';

type RowMetadata = {
  country?: string;
  city?: string;
  country_overrides?: Record<string, string>;
  city_overrides?: Record<string, string>;
};

/** The diagnostic hash of a sticky id or exit address, for records that must not carry the value. */
function hashed(value: string): string {
  const hash = diagHash(value);
  if (!hash)
    throw new Error(
      'an empty sticky id or exit address has no diagnostic hash',
    );
  return hash;
}

/** The row's country and city for the target platform: its per-platform override, else its own. */
function rowGeography(
  row: ProviderRow,
  platform: string | undefined,
): { country?: string; city?: string } {
  const metadata = row.metadata as RowMetadata | undefined;
  const country =
    platform && metadata?.country_overrides?.[platform]
      ? metadata.country_overrides[platform]
      : metadata?.country;
  const city =
    platform && metadata?.city_overrides?.[platform]
      ? metadata.city_overrides[platform]
      : metadata?.city;
  return {
    country,
    city: city ? String(city).toLowerCase().replace(/\s+/g, '_') : undefined,
  };
}

/**
 * An address of the row's gateway this run may use for the platform: a
 * live load-balancer answer (a burn binds to the platform it was observed
 * on), else the system resolver's address when the load balancer's records
 * cannot be read; when neither resolves, both causes are said.
 */
async function gatewayAddress(
  row: ProviderRow,
  platform: string | undefined,
  isBurned: (ip: string, platform?: string) => Promise<boolean>,
): Promise<{ host: string } | { rejected: string }> {
  const records = await resolve4(row.proxy_host).then(
    (answers) => ({ answers }),
    (error: Error) => ({ unresolved: error.message }),
  );
  if ('answers' in records) {
    const live: string[] = [];
    for (const ip of records.answers)
      if (!(await isBurned(ip, platform))) live.push(ip);
    if (!live.length) return { rejected: 'all_dns_answers_burned' };
    return { host: live[Math.floor(Math.random() * live.length)] };
  }
  const system = await lookup(row.proxy_host).then(
    ({ address }) => ({ address }),
    (error: Error) => ({ unresolved: error.message }),
  );
  if ('unresolved' in system)
    return {
      rejected: `dns_unresolved: ${row.proxy_host}: resolve4: ${records.unresolved}; lookup: ${system.unresolved}`,
    };
  return (await isBurned(system.address, platform))
    ? { rejected: 'dns_answer_burned' }
    : { host: system.address };
}

export async function resolveProxy(
  proxy: string,
  targetHost?: string,
  preflightPersona?: LinkedInProbePersona,
): Promise<ResolvedProxy | undefined> {
  if (requestsNoProxy(proxy)) return undefined;
  const startedAt = new Date().toISOString();
  if (requestsUrlForm(proxy))
    return resolveUrlFormProxy(proxy, targetHost, startedAt);

  const attempts: ProxyPreflightAttempt[] = [];
  const { candidates, undeclared, proxyType, ccOverride } =
    await providerCandidates(proxy);
  const platform = platformFromTarget(targetHost);
  const rejection = (
    row: ProviderRow,
    country: string | undefined,
    reason: string,
  ): ProxyPreflightAttempt => ({
    provider: row.provider,
    display_name: row.display_name,
    proxy_type: proxyType,
    country: country ? country : 'not stated',
    endpoint: { host: row.proxy_host, port: String(row.proxy_port) },
    sticky_hash: 'no sticky session',
    rejected_reason: reason,
  });
  for (const row of undeclared) {
    console.log(
      `[proxy] Skipping ${row.display_name}: its Skarbiec context declares no proxy_type (isp, mobile or residential), so it cannot answer a "${proxy}" request`,
    );
    attempts.push(rejection(row, undefined, 'proxy_type_undeclared'));
  }

  const { retiredProviderReason, isProviderBlockedForPlatform } = await import(
    '../policy.js'
  );
  const { isBurned } = await import('../burned.js');
  for (const row of candidates) {
    const retiredReason = retiredProviderReason(row.proxy_host, row.proxy_port);
    if (retiredReason) {
      console.log(
        `[proxy] BLOCKED: ${row.display_name} host=${row.proxy_host}:${row.proxy_port} retired=${retiredReason} - skipping`,
      );
      attempts.push(rejection(row, undefined, `retired:${retiredReason}`));
      continue;
    }
    const secretService = row.secret_service
      ? row.secret_service
      : secretServiceFor(row.provider, row.proxy_type);
    if (!secretService) {
      console.log(
        `[proxy] Skipping ${row.display_name}: no scoped provider credential names it`,
      );
      attempts.push(rejection(row, undefined, 'unscoped_provider'));
      continue;
    }
    const username = readOptionalWelesServiceSecret(secretService, 'username');
    const password = readOptionalWelesServiceSecret(secretService, 'password');
    // A provider that intercepts TLS by design declares the SPKI hashes of
    // its authority on its own item; one that declares none is verified.
    const tlsSpki = readOptionalWelesServiceSecret(secretService, 'tls_spki');
    if (!username || !password) {
      console.log(
        `[proxy] Skipping ${row.display_name}: exact provider grant unavailable`,
      );
      attempts.push(rejection(row, undefined, 'missing_exact_provider_grant'));
      continue;
    }
    const geography = rowGeography(row, platform);
    const stated = ccOverride ? ccOverride : geography.country;
    if (!stated) {
      console.log(
        `[proxy] Skipping ${row.display_name}: neither the request "${proxy}" nor the row states a country`,
      );
      attempts.push(rejection(row, undefined, 'country_unstated'));
      continue;
    }
    const cc = stated.toLowerCase();
    // Row policy: skip providers blocked for the target platform regardless
    // of how the resolver got here.
    if (isProviderBlockedForPlatform(row.provider, platform)) {
      console.log(
        `[proxy] BLOCKED: ${row.display_name} is on toxic list for ${platform} — skipping`,
      );
      attempts.push(rejection(row, cc, 'provider_blocked_for_platform'));
      continue;
    }
    // A sticky session id only has to be new. The host's monotonic clock in
    // nanoseconds gives every attempt on this host its own, kept within the
    // integers the providers' digit-only session fields and the preflight log take.
    const sessId = Number(
      process.hrtime.bigint() % BigInt(Number.MAX_SAFE_INTEGER),
    );
    const { username: stickyUser, password: stickyPass } = stickyCredentials(
      row.provider,
      row.proxy_type,
      { username, password },
      { country: cc, city: geography.city, sessionId: sessId },
    );
    const attemptDiag: ProxyPreflightAttempt = {
      provider: row.provider,
      display_name: row.display_name,
      proxy_type: proxyType,
      country: cc,
      endpoint: { host: row.proxy_host, port: String(row.proxy_port) },
      sticky_hash: hashed(String(sessId)),
    };
    attempts.push(attemptDiag);
    const gateway = await gatewayAddress(row, platform, isBurned);
    if ('rejected' in gateway) {
      attemptDiag.rejected_reason = gateway.rejected;
      continue;
    }
    const { host } = gateway;
    attemptDiag.endpoint = { host, port: String(row.proxy_port) };
    const verdict = await preflightExit({
      host,
      port: String(row.proxy_port),
      stickyUser,
      stickyPass,
      cc,
      platform,
      targetHost,
      displayName: row.display_name,
      sessId,
      preflightPersona,
      attemptDiag,
      isBurned,
    });
    if (verdict.abandonProvider || verdict.rejected) continue;
    const exitIp = verdict.exitIp ? verdict.exitIp : undefined;
    console.log(
      `[proxy] Using: ${row.display_name} (${host}:${row.proxy_port}, sticky=${sessId}, exit=${exitIp ? exitIp : 'not read'})`,
    );
    // The winning exit is enriched once through ip-api (ASN, ISP, geography,
    // proxy/hosting/mobile flags); a read that failed is kept in the
    // preflight record with its cause.
    let exitReputation: ExitReputation | undefined;
    let exitReputationError: string | undefined;
    if (exitIp) {
      const { verifyExitReputation } = await import('../policy.js');
      await verifyExitReputation(exitIp).then(
        (reputation) => {
          exitReputation = reputation;
        },
        (error: Error) => {
          exitReputationError = error.message;
        },
      );
    }
    writeProxyPreflightDiagnostics({
      requested_proxy: proxy,
      target_host: targetHost,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      selected: true,
      selected_provider: row.display_name,
      selected_endpoint: { host, port: String(row.proxy_port) },
      selected_exit_ip_hash: exitIp ? hashed(exitIp) : undefined,
      selected_exit_reputation: exitReputation,
      selected_exit_reputation_error: exitReputationError,
      attempt_count: attempts.length,
      attempts,
    });
    return {
      server: `http://${host}:${row.proxy_port}`,
      username: stickyUser,
      password: stickyPass,
      country: cc,
      city: geography.city,
      exit_ip: exitIp,
      platform,
      provider: row.provider,
      proxy_type: proxyType,
      sticky_session_id: String(sessId),
      sticky_hash: hashed(String(sessId)),
      exit_reputation: exitReputation,
      tls_spki: tlsSpki
        ? tlsSpki
            .split(',')
            .map((hash) => hash.trim())
            .filter(Boolean)
        : undefined,
    };
  }

  console.log(`[proxy] No working provider found for type="${proxy}"`);
  writeProxyPreflightDiagnostics({
    requested_proxy: proxy,
    target_host: targetHost,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    selected: false,
    failure_reason: 'no_working_provider',
    attempt_count: attempts.length,
    attempts,
  });
  return undefined;
}
