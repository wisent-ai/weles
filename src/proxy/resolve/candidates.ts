// Which provider rows a proxy request is tried against, in what order: the
// Skarbiec proxy records plus the static ISP rows, narrowed by the pool type
// and provider the request names, shuffled unless static. A row's provider
// is derived from its endpoint and its pool type is what the row declares
// (`proxy_type` in its Skarbiec context); a row that declares no pool type
// cannot answer a typed request and is returned under `undeclared` so the
// resolver reports it instead of guessing.
import type { WelesServiceSecret } from '../../secrets/scoped-service.js';
import { listServiceMetadata } from '../../state/skarbiec-records.js';
import { ALL_PROVIDERS } from '../capability.js';
import { providerFromHost } from '../policy.js';
import {
  proxyTypeOf,
  type ProxyType,
} from '../sources/provider_credentials.js';

export type ProviderRow = {
  display_name: string;
  proxy_host: string;
  proxy_port: string;
  provider?: string;
  proxy_type?: ProxyType;
  secret_service?: WelesServiceSecret;
  balance_usd: number;
  metadata?: { country?: string };
};

export type ProviderCandidates = {
  candidates: ProviderRow[];
  undeclared: ProviderRow[];
  proxyType: ProxyType | 'unknown';
  ccOverride: string | undefined;
};

export async function providerCandidates(
  proxy: string,
): Promise<ProviderCandidates> {
  const providers: ProviderRow[] = listServiceMetadata('proxy')
    .filter((record) => record.host && record.port)
    .map(
      (record): ProviderRow => ({
        display_name: String(record.display_name ?? record.id),
        proxy_host: String(record.host),
        proxy_port: String(record.port),
        provider:
          typeof record.provider === 'string'
            ? record.provider
            : providerFromHost(String(record.host)),
        proxy_type: proxyTypeOf(record.proxy_type),
        balance_usd:
          typeof record.balance_usd === 'number' ? record.balance_usd : 0,
        metadata:
          record.metadata && typeof record.metadata === 'object'
            ? (record.metadata as { country?: string })
            : undefined,
      }),
    );
  // Decodo first — canonical static ISP (real residential ASNs). Skip-shuffle
  // branch below keeps this order deterministic for isp requests.
  const {
    maybeOxylabsIspRow,
    maybeOxylabsDedicatedIspRow,
    maybeDecodoIspRows,
  } = await import('../sources/isp_row.js');
  for (const r of [
    ...maybeDecodoIspRows(),
    maybeOxylabsIspRow(),
    maybeOxylabsDedicatedIspRow(),
  ])
    if (r) providers.push(r);

  const request = proxy.toLowerCase();
  // Tokens after the pool type may include a 2-letter country code
  // ('residential us', 'residential br') to override the row's stored country.
  // `\b([a-z]{2})\b` already yields two-letter tokens only, so the country
  // code is the first of them.
  const ccOverride = (request.match(/\b([a-z]{2})\b/g) ?? [])[0];
  const proxyType: ProxyType | 'unknown' = /\bisp\b/.test(request)
    ? 'isp'
    : /\bmobile\b/.test(request)
      ? 'mobile'
      : /\bresidential\b/.test(request)
        ? 'residential'
        : 'unknown';
  const undeclared =
    proxyType === 'unknown' ? [] : providers.filter((p) => !p.proxy_type);
  let filtered =
    proxyType === 'unknown'
      ? providers
      : providers.filter((p) => p.proxy_type === proxyType);

  // Explicit provider targeting, e.g. 'pingproxies residential': the names
  // are the ones `proxy/capability.ts` declares, matched against the
  // provider the row's endpoint derives.
  const explicit = ALL_PROVIDERS.find((name) => request.includes(name));
  if (explicit) filtered = filtered.filter((p) => p.provider === explicit);

  // Shuffle residential/mobile (per-pool rate limits). ISP stays deterministic.
  if (proxyType !== 'isp')
    for (let i = filtered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
    }
  return { candidates: filtered, undeclared, proxyType, ccOverride };
}
