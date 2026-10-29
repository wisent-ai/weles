// Retired provider pools, kept in Skarbiec's Weles settings as
// `retired_proxy_pools`:
//   { domains: [{ domain, reason }], ranges: [{ range, reason }],
//     ports: [{ port, reason }] }
// An account whose stored proxy points into one of them is burned, never
// rerouted through another provider: it keeps the exit it registered on, so
// when that pool retires the account retires with it. A domain names the
// pool's gateway host and every subdomain of it, a range an address block
// in `<address>/<prefix>` form, and a port the gateway port a pool exposes
// on every hostname (it catches the pool when its address blocks drift).
// Read on every question, so a pool retired a moment ago applies now; a
// setting nobody wrote retires nothing, and an entry that is not one of these
// shapes is refused by name.
import { BlockList, isIP } from 'node:net';
import { readSetting } from '../../../state/skarbiec-records.js';

type RetiredDomain = { domain: string; reason: string };
type RetiredRange = { range: string; reason: string };
type RetiredPort = { port: number; reason: string };
type RetiredPools = {
  domains: RetiredDomain[];
  ranges: RetiredRange[];
  ports: RetiredPort[];
};

const SETTING = 'retired_proxy_pools';

function family(address: string): 'ipv4' | 'ipv6' {
  const version = isIP(address);
  if (!version)
    throw new Error(`${SETTING} names ${address}, which is not an address`);
  return version === isIP('::') ? 'ipv6' : 'ipv4';
}

function inRange(range: string, address: string): boolean {
  const [network, prefix] = range.split('/');
  if (!/^\d+$/.test(prefix))
    throw new Error(`${SETTING} range ${range} names no prefix length`);
  const blocked = new BlockList();
  blocked.addSubnet(network, Number(prefix), family(network));
  return blocked.check(address, family(address));
}

function underDomain(domain: string, host: string): boolean {
  const name = host.toLowerCase();
  const pool = domain.toLowerCase();
  return name === pool || name.endsWith(`.${pool}`);
}

/** Why the proxy at `host`:`port` belongs to a retired pool, or nothing when no declared pool holds it. */
export function retiredProviderReason(
  host: string | undefined,
  port: number | string | undefined,
): string | undefined {
  const declared = readSetting<RetiredPools>(SETTING, {
    domains: [],
    ranges: [],
    ports: [],
  });
  if (port !== undefined && port !== '') {
    const number = Number(port);
    const pool = declared.ports.find((entry) => entry.port === number);
    if (pool) return pool.reason;
  }
  if (!host) return undefined;
  const domain = declared.domains.find((entry) =>
    underDomain(entry.domain, host),
  );
  if (domain) return domain.reason;
  if (!isIP(host)) return undefined;
  const range = declared.ranges.find((entry) => inRange(entry.range, host));
  return range?.reason;
}
