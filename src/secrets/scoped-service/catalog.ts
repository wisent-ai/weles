// The deployed acquisition catalogue, read in exactly one place.
//
// The catalogue and the contract table are one declaration split across two
// files, and nothing re-syncs the copies a host accumulates: this workstation
// carried four, at four different revisions of the same authored file, and a
// Skarbiec-side serving-path doctor already had to be corrected for reading the
// wrong one. So the copy actually in force is parsed here, and both the reader
// gate and the read path speak from it: two spellings of this grammar is how
// the copies drifted unnoticed.
//
// Moved verbatim during a split by responsibility, with one repair: a
// catalogue that cannot be read is no longer reported as a catalogue that
// grants nothing. Those are different failures with different repairs, and
// they were indistinguishable.

import { readFileSync } from 'node:fs';

import { acquisitionScopesFile, checkedTokenFile, skarbiecEndpoint } from './authority';
import { resolvedAcquiredSecretContract, type InternalAcquiredSecretContract } from './contracts';

/// Is this the error the filesystem raises for a path that is not there?
function isAbsentPath(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT';
}

// Every field the catalogue grants this contract's own reader identity on this
// contract's item. `null` when there is no catalogue on this machine at all,
// which is a different state from a catalogue that grants nothing.
function managedReaderGrantedFields(
  contract: InternalAcquiredSecretContract,
  tenantId?: string | null,
): string[] | null {
  const readerConsumer = contract.readerConsumer;
  if (!readerConsumer) return [];
  let text: string;
  try {
    text = readFileSync(acquisitionScopesFile(tenantId), 'utf8');
  } catch (error) {
    if (isAbsentPath(error)) return null;
    throw error;
  }
  const granted: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const columns = trimmed.split('|');
    if (columns.length !== Number('3')) continue;
    const [consumer, item, field] = columns;
    // The consumer column carries the field too, so a row counts only when it
    // names exactly this contract's reader for exactly the field it grants.
    if (item === contract.item && consumer === `${readerConsumer}-${field}`) granted.push(field);
  }
  return granted;
}

// A catalog that grants this item to its reader on a DIFFERENT field than the
// contract declares is the drift that costs the most to diagnose. Every symptom
// downstream is a credential that cannot be read, and both the reader gate and
// the acquisition helper report it as though nothing were granted at all: the
// helper names the field the contract asked for, so the row that does exist never
// appears in the refusal. Name the disagreement instead, and name the copy that is
// in force, because which catalog was read is the fact that resolves it. Null when
// there is nothing to say: an absent row and an absent catalogue are different
// failures that already carry their own messages.
export function welesManagedCredentialReaderMismatch(
  secretName: string,
  field: string,
  tenantId?: string | null,
): string | null {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || contract.field !== field || !contract.readerConsumer) return null;
  const catalog = acquisitionScopesFile(tenantId);
  const granted = managedReaderGrantedFields(contract, tenantId);
  if (!granted || !granted.length || granted.includes(field)) return null;
  return `deployed Skarbiec acquisition catalog ${catalog} grants ${contract.item}`
    + ` to its reader on ${granted.join(', ')}, but this revision's Weles credential`
    + ` contract declares field ${field}: the catalog copy in force is not the one`
    + ` this revision was built against`;
}

export function hasWelesManagedCredentialReader(
  secretName: string,
  field: string,
  tenantId?: string | null,
): boolean {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || contract.field !== field || !contract.readerConsumer) return false;
  return managedReaderGrantedFields(contract, tenantId)?.includes(field) ?? false;
}

export function hasWelesAcquiredSecretWriter(secret: string, tenantId?: string | null): boolean {
  const contract = resolvedAcquiredSecretContract(secret);
  if (!contract) return false;
  skarbiecEndpoint(tenantId);
  return Boolean(checkedTokenFile(contract.writerTokenFile, tenantId));
}
