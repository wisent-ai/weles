// Which network addresses are public is read from IANA's Special-Purpose
// Address Registries (RFC 6890, RFC 8190), never written here: an address in a
// registered block is public only when its most specific block is declared
// Globally Reachable, and every other address is ordinary unicast.
// https://www.iana.org/assignments/iana-ipv4-special-registry
// https://www.iana.org/assignments/iana-ipv6-special-registry
//
// The registries are read once per process by loadSpecialAddresses(); the
// checks after it are synchronous, so a per-request route handler can call
// them. A check before the registries were read is refused, never answered.
import { BlockList, isIP, isIPv6 } from 'node:net';

type Family = 'ipv4' | 'ipv6';

const REGISTRY_CSV: Record<Family, string> = {
  ipv4: 'https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv',
  ipv6: 'https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv',
};

/** The registry columns read, by the header IANA gives them. */
const ADDRESS_COLUMN = 'Address Block';
const NAME_COLUMN = 'Name';
const REACHABLE_COLUMN = 'Globally Reachable';

export interface SpecialBlock {
  prefix: string;
  length: number;
  name: string;
  globallyReachable: boolean;
  members: BlockList;
}

/** One CSV record's fields (RFC 4180): commas split fields, quotes enclose them, a doubled quote inside is a quote. */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  // A quote inside a quoted field either closes it or, doubled, stands for itself.
  let quoteSeen = false;
  for (const char of line) {
    if (quoteSeen) {
      quoteSeen = false;
      if (char === '"') {
        field += char;
        continue;
      }
      quoted = false;
    }
    if (quoted) {
      if (char === '"') quoteSeen = true;
      else field += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/** A field without IANA's bracketed footnote and RFC references, as in "False [1]" or a prefix followed by "[2]". */
function withoutNotes(field: string): string {
  return field.replace(/\[[^\]]*\]/g, '').trim();
}

function blockOf(
  prefix: string,
  name: string,
  globallyReachable: boolean,
  family: Family,
): SpecialBlock {
  const [network, bits] = prefix.split('/');
  const length = Number(bits);
  if (!network || !bits || !Number.isInteger(length)) {
    throw new Error(
      `the IANA ${family} special-purpose registry lists "${prefix}" (${name}), which is not an address prefix`,
    );
  }
  const members = new BlockList();
  members.addSubnet(network, length, family);
  return { prefix, length, name, globallyReachable, members };
}

async function readRegistry(family: Family): Promise<SpecialBlock[]> {
  const address = REGISTRY_CSV[family];
  const answer = await fetch(address, { headers: { Accept: 'text/csv' } });
  if (!answer.ok)
    throw new Error(`IANA answered ${address} with HTTP ${answer.status}`);
  const [header, ...records] = (await answer.text())
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!header) throw new Error(`${address} is empty`);
  const columns = csvFields(header);
  const column = (name: string): number => {
    if (!columns.includes(name))
      throw new Error(
        `${address} has no "${name}" column; its header is ${header}`,
      );
    return columns.indexOf(name);
  };
  const addressAt = column(ADDRESS_COLUMN);
  const nameAt = column(NAME_COLUMN);
  const reachableAt = column(REACHABLE_COLUMN);
  const blocks = records.flatMap((record) => {
    const fields = csvFields(record);
    const name = withoutNotes(String(fields[nameAt]));
    const globallyReachable =
      withoutNotes(String(fields[reachableAt])) === 'True';
    return withoutNotes(String(fields[addressAt]))
      .split(',')
      .map((prefix) => prefix.trim())
      .filter(Boolean)
      .map((prefix) => blockOf(prefix, name, globallyReachable, family));
  });
  if (!blocks.length)
    throw new Error(`${address} lists no special-purpose blocks`);
  return blocks;
}

let registries: Record<Family, SpecialBlock[]> | null = null;
let reading: Promise<void> | null = null;

/**
 * Reads both registries once per process. A failed read is not kept: the
 * next call reads again, and the error names the registry and its cause.
 */
export function loadSpecialAddresses(): Promise<void> {
  if (registries) return Promise.resolve();
  if (reading) return reading;
  reading = Promise.all([readRegistry('ipv4'), readRegistry('ipv6')])
    .then(([ipv4, ipv6]) => {
      registries = { ipv4, ipv6 };
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

/**
 * The most specific registered block `address` falls in, or null when it is
 * in none (ordinary unicast). Refused before loadSpecialAddresses() has read
 * the registries, and for text that is not an address.
 */
export function specialBlockOf(address: string): SpecialBlock | null {
  if (!registries) {
    throw new Error(
      `cannot judge ${address}: the IANA special-purpose registries have not been read in this process (loadSpecialAddresses)`,
    );
  }
  if (!isIP(address)) throw new Error(`${address} is not an IP address`);
  let family: Family = 'ipv4';
  if (isIPv6(address)) family = 'ipv6';
  const matching = registries[family].filter((block) =>
    block.members.check(address, family),
  );
  if (!matching.length) return null;
  return matching.reduce((best, block) =>
    block.length > best.length ? block : best,
  );
}

/** Refuses an address that is not globally reachable, naming the IANA block it falls in. */
export function assertGloballyReachable(address: string): void {
  const block = specialBlockOf(address);
  if (block && !block.globallyReachable) {
    throw new Error(
      `non-public network address denied: ${address} is in ${block.prefix} (${block.name}), which IANA does not declare globally reachable`,
    );
  }
}
