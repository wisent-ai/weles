import { execFileSync, spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

export interface WelesAccountRecord {
  id: string;
  platform: string;
  username: string;
  password: string;
  active: boolean;
  metadata: Record<string, any>;
  context: Record<string, any>;
}

const SKARBIEC_RESOLVER = join(__dirname, '..', '..', 'src', '_shared', 'skarbiec-runtime.mjs');
let resolvedSkarbiecBinary: string | undefined;

function activeSkarbiecBinary(operation: string): string {
  if (resolvedSkarbiecBinary) return resolvedSkarbiecBinary;
  const result = spawnSync(process.execPath, [SKARBIEC_RESOLVER, 'active-binary'], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const binary = String(result.stdout ?? '').trim();
  if (result.error || result.status !== 0 || !isAbsolute(binary)) {
    const detail = result.error?.message
      || String(result.stderr ?? '').trim()
      || (result.status !== 0
        ? `resolver exited with status ${result.status ?? 'unknown'}`
        : binary
          ? 'resolver returned a non-absolute path'
          : 'resolver returned no path');
    throw new Error(`cannot ${operation}: Stado returned no attested active Skarbiec binary: ${detail}`);
  }
  resolvedSkarbiecBinary = binary;
  return binary;
}
const VAULT = process.env.SKARBIEC_VAULT_FILE;
const ACCOUNT_ID = /^weles-[a-z0-9][a-z0-9-]{0,126}-account$/;

function skarbiec(args: string[], input?: string): string {
  return execFileSync(activeSkarbiecBinary(`run Skarbiec ${args[0] ?? 'operation'}`), args, {
    input,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, SKARBIEC_VAULT_FILE: VAULT },
  });
}

export function listCredentialItems(): Array<Record<string, any>> {
  const rows = JSON.parse(skarbiec(['list'])) as Array<Record<string, any>>;
  if (!Array.isArray(rows)) throw new Error('Skarbiec list returned a non-array inventory');
  return rows.filter((row) => !row.deleted && row.state !== 'deleted');
}

function itemIds(kind?: string): string[] {
  return listCredentialItems().filter((row) => !kind || row.kind === kind)
    .map((row) => String(row.name ?? row.id ?? ''))
    .filter(Boolean);
}

// The Skarbiec tag namespace a consumer selects a secret by (registered by
// Skarbiec for Stado and every product that asks for secrets by role).
const ROLE_TAG_PREFIX = 'stado:role:';
const ROLE = /^[a-z0-9][a-z0-9-]{0,126}$/;

/**
 * The id of the one live item carrying `stado:role:<role>`. The item's id is
 * read only after this selection, so no caller names an item; no holder and
 * several holders are both refused, because reading either would be a guess.
 */
export function itemPlayingRole(role: string): string {
  if (!ROLE.test(role)) throw new Error(`invalid role ${JSON.stringify(role)}`);
  const tag = `${ROLE_TAG_PREFIX}${role}`;
  const holders = listCredentialItems().filter((row) => Array.isArray(row.tags) && row.tags.includes(tag));
  if (holders.length === 0) {
    throw new Error(`no Skarbiec item carries ${tag}; store the secret for role ${role} with \`stado credentials item put --host <vault owner> --role ${role}\``);
  }
  if (holders.length > 1) throw new Error(`${holders.length} Skarbiec items carry ${tag}; exactly one item may play role ${role}`);
  return String(holders[0].id ?? holders[0].name ?? '');
}

export function readDocument(id: string): Record<string, any> {
  return JSON.parse(skarbiec(['get', id])) as Record<string, any>;
}

export function writeDocument(id: string, document: Record<string, any>): void {
  skarbiec(['set-json', id], JSON.stringify(document));
}

export function listServiceMetadata(category?: string): Array<Record<string, any>> {
  return itemIds().map((id) => ({ id, document: readDocument(id) }))
    .filter(({ document }) => document.context?.owner === 'weles'
      || document.context?.source_kind === 'proxy')
    .map(({ id, document }) => ({
      id,
      ...document.context,
      category: document.context?.category ?? document.context?.source_kind,
    }))
    .filter((record) => !category || record.category === category);
}

function accountFromDocument(id: string, document: Record<string, any>): WelesAccountRecord {
  const fields = document.fields ?? {};
  const context = document.context ?? {};
  return {
    id,
    platform: String(context.platform ?? ''),
    username: String(fields.username ?? ''),
    password: String(fields.password ?? ''),
    active: context.active !== false,
    metadata: fields.metadata_json ? JSON.parse(String(fields.metadata_json)) : {},
    context,
  };
}

/** Active trajectory accounts, optionally of one platform. */
export function listAccounts(platform?: string): WelesAccountRecord[] {
  return itemIds().filter((id) => ACCOUNT_ID.test(id))
    .map((id) => accountFromDocument(id, readDocument(id)))
    .filter((account) => account.active && (!platform || account.platform === platform));
}

/** One account record whether active or not, or null when no such item exists. */
export function readAccount(id: string): WelesAccountRecord | null {
  if (!ACCOUNT_ID.test(id) || !itemIds().includes(id)) return null;
  return accountFromDocument(id, readDocument(id));
}

/** One active account a trajectory may use; an inactive (banned, deleted) account is not returned. */
export function getAccount(id: string): WelesAccountRecord | null {
  const account = readAccount(id);
  return account?.active ? account : null;
}

/**
 * Write an account's profile without touching its credential fields: an
 * existing item keeps username and password and gains the metadata, display
 * name and active flag; a new item holds the username and metadata only, and
 * its credential is written later through credential intake.
 */
export function putAccountProfile(record: {
  platform: string;
  username: string;
  metadata: Record<string, unknown>;
  displayName?: string;
}): string {
  const id = accountItemId(record.platform, record.username);
  if (!itemIds().includes(id)) {
    skarbiec(['set', id, '--type', 'bundle', `username=${record.username}`, `metadata_json=${JSON.stringify(record.metadata)}`]);
  }
  const document = readDocument(id);
  const fields = document.fields ?? {};
  const current = fields.metadata_json ? JSON.parse(String(fields.metadata_json)) : {};
  fields.metadata_json = JSON.stringify({ ...current, ...record.metadata });
  document.fields = fields;
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: 'trajectory-account',
    platform: record.platform,
    display_name: record.displayName ?? document.context?.display_name ?? record.username,
    active: true,
  };
  writeDocument(id, document);
  return id;
}

export function accountItemId(platform: string, username: string): string {
  const slug = username.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `weles-${platform.toLowerCase()}-${slug}-account`;
  if (!ACCOUNT_ID.test(id)) throw new Error('cannot derive a safe Weles account item id');
  return id;
}

export function putAccount(record: {
  platform: string;
  username: string;
  password: string;
  metadata: Record<string, unknown>;
  displayName?: string;
}): string {
  const id = accountItemId(record.platform, record.username);
  skarbiec([
    'set',
    id,
    '--type',
    'bundle',
    `username=${record.username}`,
    `password=${record.password}`,
    `metadata_json=${JSON.stringify(record.metadata)}`,
  ]);
  const document = readDocument(id);
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: 'trajectory-account',
    platform: record.platform,
    display_name: record.displayName ?? record.username,
    active: true,
  };
  writeDocument(id, document);
  return id;
}

export function updateAccount(id: string, patch: { metadata?: Record<string, any>; active?: boolean }): boolean {
  if (!ACCOUNT_ID.test(id)) return false;
  const document = readDocument(id);
  const fields = document.fields ?? {};
  const current = fields.metadata_json ? JSON.parse(String(fields.metadata_json)) : {};
  if (patch.metadata) fields.metadata_json = JSON.stringify({ ...current, ...patch.metadata });
  document.fields = fields;
  document.context = { ...(document.context ?? {}), ...(patch.active === undefined ? {} : { active: patch.active }) };
  writeDocument(id, document);
  return true;
}

function settingItemId(key: string): string {
  if (!/^[a-z][a-z0-9_]{0,126}$/.test(key)) throw new Error(`invalid Weles setting: ${key}`);
  return `weles-setting-${key.replaceAll('_', '-')}`;
}

export function readSetting<T>(key: string, fallback: T): T {
  try {
    const document = readDocument(settingItemId(key));
    const raw = document.fields?.value_json;
    return raw ? JSON.parse(String(raw)) as T : fallback;
  } catch {
    return fallback;
  }
}

export function writeSetting<T>(key: string, value: T): void {
  const id = settingItemId(key);
  skarbiec(['set', id, '--type', 'bundle', `value_json=${JSON.stringify(value)}`]);
  const document = readDocument(id);
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: 'runtime-setting',
    setting_key: key,
  };
  writeDocument(id, document);
}
