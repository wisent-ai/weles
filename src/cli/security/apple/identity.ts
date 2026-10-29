// The local half of an Apple Developer ID: the openssl and Stado children
// `weles certificate` runs on this machine to read an issued certificate and
// to keep it, with its private key, as the signing identity release recipes
// read. Every failed child is reported with what it said and how it ended.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { UsageError } from '../../usage.js';

/** A Stado host name, as `--execution-host` and `--store-host` take it. */
export const HOST = /^[A-Za-z\d][A-Za-z\d._-]*$/;
// The role every darwin release recipe reads its signing identity through
// (MACOS_CERT_P12, MACOS_CERT_PASSWORD, MACOS_SIGN_IDENTITY): Stado selects
// the vault item tagged stado:role:<role>, so no item is named here.
const SIGNING_ROLE = 'macos-developer-id';
const SIGNING_ITEM_KIND = 'bundle';

// Why a child ended without its answer: what it wrote to stderr, or, when it
// wrote nothing there, why it could not be run, the signal that stopped it,
// or the status it exited with.
function failureOf(result: SpawnSyncReturns<string | Buffer>): string {
  const stderr = result.stderr ? result.stderr.toString().trim() : '';
  if (stderr) return stderr;
  if (result.error) return result.error.message;
  if (result.signal) return `stopped by ${result.signal}`;
  return `exit ${result.status}`;
}

// A child ran, was not stopped by a signal, and exited with success.
function succeeded(result: SpawnSyncReturns<string | Buffer>): boolean {
  return !result.error && !result.signal && result.status !== null && !result.status;
}

/** Run openssl with `argv`, refusing with its own words when it fails. */
export function openssl(argv: string[], input?: Buffer): string {
  const result = spawnSync('openssl', argv, { input, encoding: 'utf8' });
  if (!succeeded(result)) {
    const [operation] = argv;
    throw new Error(`openssl ${operation}: ${failureOf(result)}`);
  }
  return result.stdout;
}

// The certificate's common name, which is the identity codesign selects.
function commonName(certificate: Buffer): string {
  const subject = openssl(
    ['x509', '-inform', 'DER', '-noout', '-subject', '-nameopt', 'multiline'],
    certificate,
  );
  const found = subject.match(/^\s*commonName\s*=\s*(?<name>.+)$/m);
  const name = found?.groups?.name?.trim();
  if (!name)
    throw new Error('the issued certificate names no common name to sign with');
  return name;
}

/**
 * Package key and certificate as one PKCS#12 and store it, with its password
 * and signing identity, in the vault the release recipes read. The password
 * reaches openssl through its environment, never its argument list.
 */
export function storeSigningIdentity(
  certificate: Buffer,
  privateKey: string,
  storeHost: string,
): Record<string, unknown> {
  if (!isAbsolute(privateKey) || !existsSync(privateKey))
    throw new UsageError(
      '--private-key must be the absolute path start mode wrote the key to',
    );
  if (!HOST.test(storeHost))
    throw new UsageError(
      '--store-host must name the Stado host whose vault owns release secrets',
    );
  const pem = openssl(
    ['x509', '-inform', 'DER', '-outform', 'PEM'],
    certificate,
  );
  const password = randomUUID();
  const packed = spawnSync(
    'openssl',
    [
      'pkcs12',
      '-export',
      '-inkey',
      privateKey,
      '-in',
      '/dev/stdin',
      '-passout',
      'env:WELES_P12_PASSWORD',
    ],
    {
      input: pem,
      env: { ...process.env, WELES_P12_PASSWORD: password },
    },
  );
  if (!succeeded(packed) || !packed.stdout?.length) {
    throw new Error(`openssl pkcs12: ${failureOf(packed)}`);
  }
  const identity = commonName(certificate);
  const payload = JSON.stringify({
    schema: 'skarbiec.item.v2',
    kind: SIGNING_ITEM_KIND,
    fields: {
      certificate_p12_base64: packed.stdout.toString('base64'),
      certificate_password: password,
      sign_identity: identity,
    },
    context: { provider: 'apple', certificate: 'developer-id-application' },
  });
  const stored = spawnSync(
    'stado',
    [
      'credentials',
      'item',
      'put',
      '--host',
      storeHost,
      '--role',
      SIGNING_ROLE,
      '--type',
      SIGNING_ITEM_KIND,
      '--json',
    ],
    {
      input: payload,
      encoding: 'utf8',
    },
  );
  if (!succeeded(stored)) {
    throw new Error(
      `stado credentials item put --role ${SIGNING_ROLE} on ${storeHost}: ${failureOf(stored)}`,
    );
  }
  return { role: SIGNING_ROLE, host: storeHost, sign_identity: identity };
}
