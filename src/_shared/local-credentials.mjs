// The ESM trajectories' side of WELES_CREDENTIALS_FILE: the same owner-only
// JSON file, item -> field -> value, that src/secrets/scoped-service/local-file.ts
// reads and writes for the compiled CommonJS side. The TypeScript build
// emits CommonJS, which cannot load this module synchronously, so the two
// sides each read the one file format; a change to it changes both files.

import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function localCredentialsFile() {
  const path = String(process.env.WELES_CREDENTIALS_FILE || '').trim();
  return path || null;
}

function readItems(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(
      `WELES_CREDENTIALS_FILE ${path} cannot be read: ${error?.message || error}`,
    );
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(
      `refusing WELES_CREDENTIALS_FILE ${path}: it must be a regular file owned by this user with mode 600`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `WELES_CREDENTIALS_FILE ${path} is not JSON: ${error?.message || error}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `WELES_CREDENTIALS_FILE ${path} must be an object of items`,
    );
  }
  for (const [item, fields] of Object.entries(parsed)) {
    if (
      !fields ||
      typeof fields !== 'object' ||
      Array.isArray(fields) ||
      Object.values(fields).some((value) => typeof value !== 'string')
    ) {
      throw new Error(
        `WELES_CREDENTIALS_FILE ${path}: item ${item} must map field names to strings`,
      );
    }
  }
  return parsed;
}

/** The field's value; a file without it is refused by name. */
export function readLocalField(path, item, field) {
  const items = readItems(path);
  const value =
    Object.hasOwn(items, item) && Object.hasOwn(items[item], field)
      ? items[item][field]
      : '';
  if (!value)
    throw new Error(`WELES_CREDENTIALS_FILE ${path} has no ${item}/${field}`);
  return value;
}

/** Merge `fields` into `item` and replace the file in one rename. */
export function writeLocalFields(path, item, fields) {
  const items = readItems(path);
  items[item] = {
    ...(Object.hasOwn(items, item) ? items[item] : {}),
    ...fields,
  };
  const staged = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.staged`,
  );
  writeFileSync(staged, JSON.stringify(items, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(staged, path);
}
