import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { InternalAcquiredSecretContract } from './contracts.js';

const SETTING = 'WELES_MANAGED_PASSWORD_CONTRACTS_FILE';
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ORIGINS: Readonly<Record<string, string>> = Object.freeze({
  microsoft: 'https://account.live.com',
  microsoft_entra: 'https://login.microsoftonline.com',
});

type Declaration = { item: string; provider: string };

/** Account names belong to the deployment, not the public executor release. */
export function managedPasswordContracts(): ReadonlyMap<
  string,
  InternalAcquiredSecretContract
> {
  const path = process.env[SETTING]?.trim();
  if (!path) return new Map();
  if (!isAbsolute(path))
    throw new Error(`${SETTING} must name an absolute file path`);
  let document: unknown;
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (typeof process.getuid === 'function' &&
        metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error(
        'expected a regular owner-only file owned by the executor user',
      );
    }
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `cannot read managed password declarations from ${SETTING} ${path}: ${(error as Error).message}`,
    );
  }
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    Object.keys(document).some(
      (key) => key !== 'schema' && key !== 'accounts',
    ) ||
    !('schema' in document) ||
    document.schema !== 'weles.managed-passwords.v1' ||
    !('accounts' in document) ||
    !Array.isArray(document.accounts)
  ) {
    throw new Error(
      `${SETTING} ${path} requires schema weles.managed-passwords.v1 and an accounts array`,
    );
  }
  const contracts = new Map<string, InternalAcquiredSecretContract>();
  for (const [index, value] of document.accounts.entries()) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'item' && key !== 'provider') ||
      typeof value.item !== 'string' ||
      !ITEM.test(value.item) ||
      typeof value.provider !== 'string' ||
      !Object.hasOwn(ORIGINS, value.provider)
    ) {
      throw new Error(
        `${SETTING} ${path} account ${index} requires an exact item identifier (1–128 ASCII letters, digits, dots, underscores or hyphens, beginning with a letter or digit) and provider microsoft or microsoft_entra`,
      );
    }
    const account = value as Declaration;
    if (contracts.has(account.item))
      throw new Error(`${SETTING} ${path} repeats item ${account.item}`);
    contracts.set(
      account.item,
      Object.freeze({
        item: account.item,
        field: 'password',
        writerConsumer: `${account.item}-writer`,
        writerTokenFile: `${account.item}-writer-skarbiec-token`,
        readerConsumer: `${account.item}-reader`,
        sourceOrigin: ORIGINS[account.provider],
        shape: 'password',
      }),
    );
  }
  return contracts;
}
