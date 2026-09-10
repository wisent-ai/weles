// Which provider rows a proxy request is tried against, in what order: the
// Skarbiec proxy records plus the static ISP rows, narrowed by the type
// and provider words in the request, shuffled unless static.
import type { WelesServiceSecret } from '../../secrets/scoped-service.js';
import { listServiceMetadata } from '../../state/skarbiec-records.js';

export type ProviderRow = {
  display_name: string;
  proxy_host: string;
  proxy_port: string;
  secret_service?: WelesServiceSecret;
  balance_usd: number;
  metadata?: { country?: string };
};

export type ProviderCandidates = {
  candidates: ProviderRow[];
  proxyType: string;
  ccOverride: string | undefined;
};

export async function providerCandidates(proxy: string): Promise<ProviderCandidates> {
  const providers: ProviderRow[] = listServiceMetadata('proxy')
    .filter((record) => record.host && record.port)
    .map((record): ProviderRow => ({
      display_name: String(record.display_name ?? record.id),
      proxy_host: String(record.host),
      proxy_port: String(record.port),
      balance_usd: typeof record.balance_usd === 'number' ? record.balance_usd : 0,
      metadata: record.metadata && typeof record.metadata === 'object'
        ? record.metadata as { country?: string }
        : undefined,
    }));
  // Decodo first — canonical static ISP (real residential ASNs). Skip-shuffle
  // branch below keeps this order deterministic for isIsp filters.
  const { maybeOxylabsIspRow, maybeOxylabsDedicatedIspRow, maybeDecodoIspRows } = await import('../sources/isp_row.js');
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
  return { candidates: filtered, proxyType, ccOverride };
}
