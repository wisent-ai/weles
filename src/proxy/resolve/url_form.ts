// A proxy handed in as a URL: honoured as given, unless its host is retired
// or its provider is on the toxic list for the target platform.
import type { ResolvedProxy } from '../config.js';
import {
  platformFromTarget,
  writeProxyPreflightDiagnostics,
} from './diagnostics.js';

/** A proxy request that names no proxy at all. */
export const NO_PROXY = 'none';
/** A proxy request for the host's own egress. */
export const DIRECT_EGRESS = 'direct';

/**
 * Whether a proxy request routes the browser without any proxy: no request,
 * or one of the two requests declared above, in any case and spacing.
 */
export function requestsNoProxy(request: string | undefined): boolean {
  if (request === undefined) return true;
  const asked = request.trim().toLowerCase();
  return !asked || asked === NO_PROXY || asked === DIRECT_EGRESS;
}

/**
 * Whether a proxy request is a proxy URL to dial as given (an http, https or
 * socks address) rather than a request the provider registry answers.
 */
export function requestsUrlForm(request: string): boolean {
  return (
    request.startsWith('http://') ||
    request.startsWith('https://') ||
    request.startsWith('socks')
  );
}

export async function resolveUrlFormProxy(
  proxy: string,
  targetHost: string | undefined,
  startedAt: string,
): Promise<ResolvedProxy | undefined> {
  const u = new URL(proxy);
  // The proxy is dialled at the port the URL names; a URL without one would be handed out as "host:".
  if (!u.port) {
    throw new Error(
      `proxy URL for ${u.hostname} names no port; state the proxy's port in the URL`,
    );
  }
  // The diagnostics record the target only when the caller named one.
  let statedTarget: string | null = null;
  if (targetHost) statedTarget = targetHost;
  // Toxicity policy on URL-form path: reject providers blocked for target.
  const { providerFromHost, isProviderBlockedForPlatform } = await import(
    '../policy.js'
  );
  const { retiredProviderReason } = await import('./exit/retired.js');
  const platformForBlock = platformFromTarget(targetHost);
  const provFromUrl = providerFromHost(
    u.hostname,
    decodeURIComponent(u.username),
  );
  const retiredReason = retiredProviderReason(u.hostname, u.port);
  // The explicit retired-proxy override permits revalidation of a blocked pool.
  const allowRetired = process.env.WELES_ALLOW_RETIRED_PROXY === '1';
  if (
    allowRetired &&
    (retiredReason ||
      isProviderBlockedForPlatform(provFromUrl, platformForBlock))
  ) {
    console.log(
      `[proxy] OVERRIDE: WELES_ALLOW_RETIRED_PROXY=1 — bypassing block for ${u.hostname}:${u.port} (would be: ${retiredReason ? retiredReason : 'toxic_for_' + platformForBlock})`,
    );
  }
  if (retiredReason && !allowRetired) {
    console.log(
      `[proxy] BLOCKED: PROXY_URL host=${u.hostname}:${u.port} retired=${retiredReason} — refusing to hand out`,
    );
    writeProxyPreflightDiagnostics({
      requested_proxy: '[url-form]',
      target_host: statedTarget,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      selected: false,
      failure_reason: 'retired_url_form_proxy',
      retired_reason: retiredReason,
      endpoint: { host: u.hostname, port: u.port },
    });
    return undefined;
  }
  if (
    isProviderBlockedForPlatform(provFromUrl, platformForBlock) &&
    !allowRetired
  ) {
    console.log(
      `[proxy] BLOCKED: PROXY_URL host=${u.hostname} maps to ${provFromUrl}, which is on the toxic list for ${platformForBlock} — refusing to hand out`,
    );
    writeProxyPreflightDiagnostics({
      requested_proxy: '[url-form]',
      target_host: statedTarget,
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
  return {
    server: `${u.protocol}//${u.hostname}:${u.port}`,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    platform: platformForBlock,
    provider: provFromUrl,
    proxy_type: 'url_unclassified',
  };
}
