#!/usr/bin/env node
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, renameSync, writeFileSync } from 'node:fs';

const trustArgument = process.argv.indexOf('--trust-output');
const trustOutput = trustArgument === -1 ? '' : process.argv[trustArgument + 1];
if (process.argv.length !== (trustOutput ? 4 : 2) || (trustArgument !== -1 && trustArgument !== 2)) {
  throw new Error('usage: generate-spis-public-admission-credential.mjs [--trust-output PATH]');
}
if (trustOutput) {
  try {
    const existing = lstatSync(trustOutput);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('trust output must be a regular file');
    throw new Error('trust output already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const receiptKeyId = `spis-${randomBytes(12).toString('hex')}`;
const receiptKeySetVersion = `spis-${randomBytes(12).toString('hex')}`;
const receiptPrivateKey = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const receiptPublicKey = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const organizationId = randomUUID();
const receiptKeys = { [receiptKeyId]: receiptPublicKey };

const item = {
  schema: 'skarbiec.item.v2',
  kind: 'internal-authority',
  fields: {
    id: 'weles-spis-public-admission',
    token: randomBytes(48).toString('base64url'),
    organization_id: organizationId,
    receipt_key_id: receiptKeyId,
    receipt_key_set_version: receiptKeySetVersion,
    receipt_private_key: receiptPrivateKey,
    receipt_public_keys_json: JSON.stringify(receiptKeys),
  },
  context: {
    owner: 'weles-admission',
    consumer: 'spis',
    capability: 'browser-evidence',
    action: 'generic_browser_task',
    receipt_algorithm: 'Ed25519',
  },
};

if (trustOutput) {
  const trust = {
    schema: 'wisent.spis-weles-receipt-trust.v1',
    organizationId,
    allowedAction: 'generic_browser_task',
    receiptKeys,
    keySetVersion: receiptKeySetVersion,
  };
  const temporary = `${trustOutput}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(trust, null, 2)}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  renameSync(temporary, trustOutput);
}
process.stdout.write(`${JSON.stringify(item)}\n`);
