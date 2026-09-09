// The one public origin a browser-evidence run may reach, the exact address set
// that origin is pinned to, and every range and hostname that is never a public
// target. Both the admission of a target and each request the context sees are
// judged here, so a run cannot drift onto a second origin or onto link-local,
// loopback or cloud-metadata space between the check and the request.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { safeText } from './withheld-ledger.js';

const DENIED_HOSTNAMES: Record<string, true> = {
  localhost: true,
  metadata: true,
  'metadata.google.internal': true,
  'instance-data': true,
  'instance-data.ec2.internal': true,
};
const NETWORK_BLOCK_LIST = new BlockList();
for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 23, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['3ffe::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fec0::', 10, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
] as const) {
  NETWORK_BLOCK_LIST.addSubnet(address, prefix, family);
}

export function configuredTarget(): { origin: string; hostname: string; addresses: string[] } {
  const origin = String(process.env.WELES_BROWSER_EVIDENCE_TARGET_ORIGIN ?? '');
  const hostname = String(process.env.WELES_BROWSER_EVIDENCE_TARGET_HOST ?? '').toLowerCase();
  let parsedOrigin: URL;
  let addresses: unknown;
  try {
    parsedOrigin = new URL(origin);
    addresses = JSON.parse(process.env.WELES_BROWSER_EVIDENCE_TARGET_ADDRESSES_JSON ?? 'null');
  } catch {
    throw new Error('browser-evidence target network binding is missing or invalid');
  }
  if (!origin || parsedOrigin.origin !== origin || parsedOrigin.protocol !== 'https:'
      || parsedOrigin.hostname.toLowerCase() !== hostname || !hostname || !Array.isArray(addresses)
      || addresses.length === 0 || addresses.some((address) => typeof address !== 'string')) {
    throw new Error('browser-evidence target network binding is missing or invalid');
  }
  const normalizedAddresses = [...new Set(addresses)].sort();
  normalizedAddresses.forEach(assertPublicAddress);
  return { origin, hostname, addresses: normalizedAddresses };
}

export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (!family || NETWORK_BLOCK_LIST.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new Error(`non-public network address denied: ${address}`);
  }
}

export async function publicAddresses(hostname: string): Promise<string[]> {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (!normalized || Object.hasOwn(DENIED_HOSTNAMES, normalized)
      || normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal')) {
    throw new Error(`non-public network hostname denied: ${hostname}`);
  }
  if (isIP(normalized)) {
    assertPublicAddress(normalized);
    return [normalized];
  }
  // Resolution runs to completion on the resolver's own attempt budget. A
  // deadline of ours here could only turn a slow answer into a refusal that
  // reads like a denied hostname, which is a different fact about the target.
  const answers = await lookup(normalized, { all: true, verbatim: true });
  const addresses = [...new Set(answers.map((answer) => answer.address))].sort();
  if (addresses.length === 0) throw new Error(`network hostname has no addresses: ${hostname}`);
  addresses.forEach(assertPublicAddress);
  return addresses;
}

export function sameAddresses(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

export async function resolveBrowserEvidenceTarget(value: string): Promise<{
  origin: string;
  hostname: string;
  addresses: string[];
}> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('browser-evidence target must be public HTTPS without credentials');
  }
  const addresses = await publicAddresses(url.hostname);
  return { origin: url.origin, hostname: url.hostname.toLowerCase(), addresses };
}

export function networkEvidenceUrl(value: URL): string {
  return safeText(`${value.origin}${value.pathname}`);
}
