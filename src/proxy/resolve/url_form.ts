// A proxy handed in as a URL: honoured as given, unless its host is retired
// or its provider is on the toxic list for the target platform.
import type { ResolvedProxy } from '../config.js';
import { platformFromTarget, writeProxyPreflightDiagnostics } from './diagnostics.js';

export async function resolveUrlFormProxy(
  proxy: string,
  targetHost: string | undefined,
  startedAt: string,
): Promise<ResolvedProxy | undefined> {
  const u = new URL(proxy);
  // Toxicity policy on URL-form path: reject providers blocked for target.
  const { providerFromHost, isProviderBlockedForPlatform, retiredProviderReason } = await import('../policy.js');
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
