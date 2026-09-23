#!/opt/homebrew/bin/node
// Render the public Spis receipt-trust document ON the host that holds the
// admission authority, and print nothing else.
//
// `stado host render-spis-admission-trust` delivers this file into the host's
// own `$HOME/.stado/files` through the audited channel and runs it there. The
// reason it runs there and not on the operator station is the private half:
// `weles-spis-public-admission` carries `receipt_private_key`, and a station
// that assembled the document locally would have to read the item's fields to
// itself first. Here the four PUBLIC fields never leave the machine either --
// only the finished five-field document does, and that document is destined
// for a public repository.
//
// The five fields, their schema and their allowed action are the contract of
// `weles-bridge/spis-weles-bridge.mjs` and `src/weles_provenance.rs` in Spis.
// This file is the one place the document is assembled; the operator-side
// reconciler validates what arrives rather than building a second copy.

import { execFileSync } from 'node:child_process';

// The Skarbiec coordinates, spelled exactly as `spis-public-admission-binding.json`
// spells them. `release/spis-public-admission-reconcile.mjs binding-refs-match`
// fails in CI if these and the binding ever disagree, so the renderer cannot
// drift away from the declaration it implements.
const ORGANIZATION_REF = 'weles-spis-public-admission#organization_id';
const KEY_ID_REF = 'weles-spis-public-admission#receipt_key_id';
const KEY_SET_VERSION_REF = 'weles-spis-public-admission#receipt_key_set_version';
const PUBLIC_KEYS_REF = 'weles-spis-public-admission#receipt_public_keys_json';

const TRUST_SCHEMA = 'wisent.spis-weles-receipt-trust.v1';
const ALLOWED_ACTION = 'generic_browser_task';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) fail(`${name} is required`);
  return value;
}

// The vault is named by the caller because which file is LIVE is a property of
// the running Skarbiec daemon, not a default: a host carries several vault
// files and the binary without `SKARBIEC_VAULT_FILE` answers from whichever one
// its default names, which on this fleet is an uninitialized one.
const skarbiec = requiredEnvironment('SKARBIEC_BIN');
const vaultFile = requiredEnvironment('SKARBIEC_VAULT_FILE');

// One field, read by name. The item id and the field name are separate argv
// entries and both are compile-time constants of this file, so no operator word
// reaches the command line; the VALUE only ever comes back on stdout, so it is
// never in an argument vector and never in an environment variable, and so
// never in this host's process table.
function readField(reference) {
  const [item, field] = reference.split('#');
  if (!item || !field) fail(`malformed Skarbiec reference: ${reference}`);
  let value;
  try {
    value = execFileSync(skarbiec, ['get', item, '--field', field], {
      // Skarbiec decrypts by spawning GnuPG, so the keyring and a real PATH
      // are as load-bearing as the vault. All three are the caller's, taken
      // from the unit the Skarbiec daemon on this host is started with.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SKARBIEC_VAULT_FILE: vaultFile,
        ...(process.env.GNUPGHOME ? { GNUPGHOME: process.env.GNUPGHOME } : {}),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    // The refusal text, never the payload: a Skarbiec error can quote the item
    // it refused and must not become a channel for its contents.
    const detail = typeof error?.stderr === 'string' ? error.stderr.trim().replace(/\s+/g, ' ') : '';
    fail(`Skarbiec refused ${item}#${field}: ${detail || 'no detail'}`);
  }
  const trimmed = value.trim();
  if (!trimmed) fail(`${item}#${field} is empty in ${vaultFile}`);
  return trimmed;
}

const organizationId = readField(ORGANIZATION_REF);
const keyId = readField(KEY_ID_REF);
const keySetVersion = readField(KEY_SET_VERSION_REF);
const publicKeysJson = readField(PUBLIC_KEYS_REF);

if (!UUID_RE.test(organizationId)) fail('receipt trust organizationId must be a UUID');

let receiptKeys;
try {
  receiptKeys = JSON.parse(publicKeysJson);
} catch {
  fail('receipt_public_keys_json is not JSON');
}
if (!receiptKeys || typeof receiptKeys !== 'object' || Array.isArray(receiptKeys)
    || Object.keys(receiptKeys).length === 0) {
  fail('receipt trust key set is invalid');
}
for (const [identifier, publicKey] of Object.entries(receiptKeys)) {
  if (!identifier.trim()) fail('a receipt key identifier is empty');
  // Node's Ed25519 `verify` -- which is what the vendored Weles client calls --
  // takes a PEM. A base64 body would pass a non-empty check here and fail at
  // the first real receipt.
  if (typeof publicKey !== 'string' || !publicKey.includes('-----BEGIN PUBLIC KEY-----')) {
    fail(`receipt key ${identifier} is not a PEM public key`);
  }
}
// The service refuses to start unless its signing key id is in its own key set
// (`scripts/worker/public-task-service.mjs`). A document that trusted a key set
// without it would verify nothing this service can sign.
if (!Object.prototype.hasOwnProperty.call(receiptKeys, keyId)) {
  fail('receipt_public_keys_json does not carry receipt_key_id');
}

const trust = {
  schema: TRUST_SCHEMA,
  organizationId,
  allowedAction: ALLOWED_ACTION,
  receiptKeys,
  keySetVersion,
};

const document = `${JSON.stringify(trust, null, 2)}\n`;
// Last gate before anything crosses the host boundary. The private half lives
// one field away from the four that were read, and this document goes to a
// public repository.
if (document.includes('PRIVATE KEY')) fail('refusing to emit private key material');
process.stdout.write(document);
