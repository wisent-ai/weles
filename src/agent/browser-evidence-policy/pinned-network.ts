// The one public origin a browser-evidence run may reach, and the exact address
// set that origin is pinned to. Whether an address is public is IANA's reading
// (src/proxy/quality/special-addresses.ts), not a list kept here, and a name
// is judged by every address it resolves to, so localhost, cloud metadata
// names and .internal hosts are refused by the private or link-local
// addresses they answer. Both the admission of a target and each request the
// context sees are judged here, so a run cannot drift onto a second origin or
// onto non-public space between the check and the request.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  assertGloballyReachable,
  loadSpecialAddresses,
} from '../../proxy/quality/special-addresses.js';
import { safeText } from './withheld-ledger.js';

/** Why the configured target cannot be used, naming the variable at fault. */
function invalidTarget(reason: string): Error {
  return new Error(
    `browser-evidence target network binding is invalid: ${reason}`,
  );
}

function requiredSetting(name: string): string {
  const value = process.env[name];
  if (!value) throw invalidTarget(`${name} is not set`);
  return value;
}

function parsedAddresses(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidTarget(
      `WELES_BROWSER_EVIDENCE_TARGET_ADDRESSES_JSON is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some((address) => typeof address !== 'string')
  ) {
    throw invalidTarget(
      'WELES_BROWSER_EVIDENCE_TARGET_ADDRESSES_JSON is not a non-empty array of address strings',
    );
  }
  return parsed;
}

/**
 * The target the run was admitted with. The IANA registries must have been
 * read (loadSpecialAddresses) before this is called.
 */
export function configuredTarget(): {
  origin: string;
  hostname: string;
  addresses: string[];
} {
  const origin = requiredSetting('WELES_BROWSER_EVIDENCE_TARGET_ORIGIN');
  const hostname = requiredSetting(
    'WELES_BROWSER_EVIDENCE_TARGET_HOST',
  ).toLowerCase();
  const addresses = parsedAddresses(
    requiredSetting('WELES_BROWSER_EVIDENCE_TARGET_ADDRESSES_JSON'),
  );
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch (error) {
    throw invalidTarget(
      `WELES_BROWSER_EVIDENCE_TARGET_ORIGIN ${origin} is not a URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsedOrigin.origin !== origin)
    throw invalidTarget(
      `${origin} is not an origin (it reads as ${parsedOrigin.origin})`,
    );
  if (parsedOrigin.protocol !== 'https:')
    throw invalidTarget(`${origin} is not https`);
  if (parsedOrigin.hostname.toLowerCase() !== hostname)
    throw invalidTarget(`${origin} is not on host ${hostname}`);
  const normalizedAddresses = [...new Set(addresses)].sort();
  normalizedAddresses.forEach(assertPublicAddress);
  return { origin, hostname, addresses: normalizedAddresses };
}

/**
 * Refuses an address IANA does not declare globally reachable, naming its
 * block; an IPv4-mapped IPv6 address is judged by the registry's own
 * IPv4-mapped block. The registries must have been read first.
 */
export function assertPublicAddress(address: string): void {
  assertGloballyReachable(address);
}

/** Every address `hostname` resolves to, each one public, or a refusal naming the first that is not. */
export async function publicAddresses(hostname: string): Promise<string[]> {
  await loadSpecialAddresses();
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (!normalized) throw new Error(`network hostname is empty: "${hostname}"`);
  if (isIP(normalized)) {
    assertPublicAddress(normalized);
    return [normalized];
  }
  // Resolution runs to completion on the resolver's own attempt budget. A
  // deadline of ours here could only turn a slow answer into a refusal that
  // reads like a denied hostname, which is a different fact about the target.
  const answers = await lookup(normalized, { all: true, verbatim: true });
  const addresses = [
    ...new Set(answers.map((answer) => answer.address)),
  ].sort();
  if (!addresses.length)
    throw new Error(`network hostname has no addresses: ${hostname}`);
  addresses.forEach(assertPublicAddress);
  return addresses;
}

export function sameAddresses(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((address, index) => address === right[index])
  );
}

export async function resolveBrowserEvidenceTarget(value: string): Promise<{
  origin: string;
  hostname: string;
  addresses: string[];
}> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(
      'browser-evidence target must be public HTTPS without credentials',
    );
  }
  const addresses = await publicAddresses(url.hostname);
  return {
    origin: url.origin,
    hostname: url.hostname.toLowerCase(),
    addresses,
  };
}

export function networkEvidenceUrl(value: URL): string {
  return safeText(`${value.origin}${value.pathname}`);
}
