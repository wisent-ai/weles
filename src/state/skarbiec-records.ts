import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

const SKARBIEC_RESOLVER = join(
  __dirname,
  '..',
  '..',
  'src',
  '_shared',
  'skarbiec-runtime.mjs',
);
let resolvedSkarbiecBinary: string | undefined;

function activeSkarbiecBinary(operation: string): string {
  if (resolvedSkarbiecBinary) return resolvedSkarbiecBinary;
  const result = spawnSync(
    process.execPath,
    [SKARBIEC_RESOLVER, 'active-binary'],
    {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const binary = String(result.stdout ?? '').trim();
  if (result.error || result.status !== 0 || !isAbsolute(binary)) {
    const detail =
      result.error?.message ||
      String(result.stderr ?? '').trim() ||
      (result.status !== 0
        ? `resolver exited with status ${result.status ?? 'unknown'}`
        : binary
          ? 'resolver returned a non-absolute path'
          : 'resolver returned no path');
    throw new Error(
      `cannot ${operation}: Stado returned no attested active Skarbiec binary: ${detail}`,
    );
  }
  resolvedSkarbiecBinary = binary;
  return binary;
}
const VAULT = process.env.SKARBIEC_VAULT_FILE;
// Weles marks each record with the kind it is (Skarbiec namespace
// weles:record:<kind>) and finds one by that tag and its own sealed context;
// an item's id is random and nothing reads meaning out of it.
const RECORD_TAG_PREFIX = 'weles:record:';
const ACCOUNT_KIND = 'trajectory-account';
const SETTING_KIND = 'runtime-setting';

function skarbiec(args: string[], input?: string): string {
  return execFileSync(
    activeSkarbiecBinary(`run Skarbiec ${args[0] ?? 'operation'}`),
    args,
    {
      input,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SKARBIEC_VAULT_FILE: VAULT },
    },
  );
}

export function listCredentialItems(): Array<Record<string, any>> {
  const rows = JSON.parse(skarbiec(['list'])) as Array<Record<string, any>>;
  if (!Array.isArray(rows))
    throw new Error('Skarbiec list returned a non-array inventory');
  return rows.filter((row) => !row.deleted && row.state !== 'deleted');
}

/**
 * The length the vault's administrative policy requires of a generated
 * secret (`skarbiec policy-set min_generated_length <N>`), or null when the
 * operator set none. Every password Weles generates for a new account takes
 * this length: it is the one place that length is stated.
 */
export function minimumGeneratedLength(): number | null {
  const policy = JSON.parse(skarbiec(['policy-get'])) as Record<
    string,
    unknown
  >;
  const stated = policy?.min_generated_length;
  if (stated === undefined || stated === null) return null;
  if (!Number.isSafeInteger(stated)) {
    throw new Error(
      `Skarbiec's policy min_generated_length is not a whole number: ${JSON.stringify(stated)}`,
    );
  }
  return stated as number;
}

function itemIds(kind?: string): string[] {
  return listCredentialItems()
    .filter((row) => !kind || row.kind === kind)
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
  const holders = listCredentialItems().filter(
    (row) => Array.isArray(row.tags) && row.tags.includes(tag),
  );
  if (holders.length === 0) {
    throw new Error(
      `no Skarbiec item carries ${tag}; store the secret for role ${role} with \`stado credentials item put --host <vault owner> --role ${role}\``,
    );
  }
  if (holders.length > 1)
    throw new Error(
      `${holders.length} Skarbiec items carry ${tag}; exactly one item may play role ${role}`,
    );
  return String(holders[0].id ?? holders[0].name ?? '');
}

export function readDocument(id: string): Record<string, any> {
  return JSON.parse(skarbiec(['get', id])) as Record<string, any>;
}

export function writeDocument(id: string, document: Record<string, any>): void {
  skarbiec(['set-json', id], JSON.stringify(document));
}

/** Write item `id` as `type` carrying exactly `tags`, the payload on stdin. */
export function writeTaggedDocument(
  id: string,
  type: string,
  document: Record<string, any>,
  tags: string[],
): void {
  skarbiec(
    ['set-json', id, '--type', type, '--tags', tags.join(',')],
    JSON.stringify(document),
  );
}

export function listServiceMetadata(
  category?: string,
): Array<Record<string, any>> {
  return itemIds()
    .map((id) => ({ id, document: readDocument(id) }))
    .filter(
      ({ document }) =>
        document.context?.owner === 'weles' ||
        document.context?.source_kind === 'proxy',
    )
    .map(({ id, document }) => ({
      id,
      ...document.context,
      category: document.context?.category ?? document.context?.source_kind,
    }))
    .filter((record) => !category || record.category === category);
}

function accountFromDocument(
  id: string,
  document: Record<string, any>,
): WelesAccountRecord {
  const fields = document.fields ?? {};
  const context = document.context ?? {};
  return {
    id,
    platform: String(context.platform ?? ''),
    username: String(fields.username ?? ''),
    password: String(fields.password ?? ''),
    active: context.active !== false,
    metadata: fields.metadata_json
      ? JSON.parse(String(fields.metadata_json))
      : {},
    context,
  };
}

/** The ids of the live items marked as Weles records of `kind`. */
function recordIds(kind: string): string[] {
  const tag = `${RECORD_TAG_PREFIX}${kind}`;
  return listCredentialItems()
    .filter((row) => Array.isArray(row.tags) && row.tags.includes(tag))
    .map((row) => String(row.id ?? row.name ?? ''))
    .filter(Boolean);
}

/** Replace `id`'s payload with a bundle holding exactly `fields`, written on stdin so no value is in argv. */
function writeBundle(
  id: string,
  fields: Record<string, string>,
  tags: string[] = [],
): void {
  skarbiec(
    [
      'set-json',
      id,
      '--type',
      'bundle',
      ...(tags.length ? ['--tags', tags.join(',')] : []),
    ],
    JSON.stringify({
      schema: 'skarbiec.item.v2',
      kind: 'bundle',
      fields,
      context: {},
    }),
  );
}

/** A new record of `kind` under a random id; returns the id. */
function createRecord(kind: string, fields: Record<string, string>): string {
  const id = randomUUID().replaceAll('-', '');
  writeBundle(id, fields, [`${RECORD_TAG_PREFIX}${kind}`]);
  return id;
}

/** The account of `platform` signed in as `username`, active or not. */
function findAccountId(platform: string, username: string): string | null {
  const wanted = username.trim().toLowerCase();
  return (
    recordIds(ACCOUNT_KIND).find((id) => {
      const account = accountFromDocument(id, readDocument(id));
      return (
        account.platform === platform &&
        account.username.trim().toLowerCase() === wanted
      );
    }) ?? null
  );
}

/**
 * Mark every Weles record that carries no `weles:record:<kind>` tag yet with
 * the kind its own context names (`context.owner === 'weles'` and
 * `context.record_kind`). Records written before Weles found them by tag are
 * found again this way; their ids are left as they are and mean nothing.
 * Tags an item already carries are kept.
 */
export function adoptRecords(): {
  tagged: Array<{ id: string; kind: string }>;
  skipped: number;
} {
  const tagged: Array<{ id: string; kind: string }> = [];
  let skipped = 0;
  for (const row of listCredentialItems()) {
    const tags: string[] = Array.isArray(row.tags) ? row.tags.map(String) : [];
    const id = String(row.id ?? row.name ?? '');
    if (!id || tags.some((tag) => tag.startsWith(RECORD_TAG_PREFIX))) {
      skipped += 1;
      continue;
    }
    const context = readDocument(id).context ?? {};
    const kind =
      typeof context.record_kind === 'string' ? context.record_kind : '';
    if (context.owner !== 'weles' || !/^[a-z][a-z0-9-]{0,62}$/.test(kind)) {
      skipped += 1;
      continue;
    }
    skarbiec([
      'retag',
      id,
      '--tags',
      [...tags, `${RECORD_TAG_PREFIX}${kind}`].join(','),
    ]);
    tagged.push({ id, kind });
  }
  return { tagged, skipped };
}

/** Active trajectory accounts, optionally of one platform. */
export function listAccounts(platform?: string): WelesAccountRecord[] {
  return recordIds(ACCOUNT_KIND)
    .map((id) => accountFromDocument(id, readDocument(id)))
    .filter(
      (account) =>
        account.active && (!platform || account.platform === platform),
    );
}

/** One account record whether active or not, or null when no such account exists. */
export function readAccount(id: string): WelesAccountRecord | null {
  if (!recordIds(ACCOUNT_KIND).includes(id)) return null;
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
  const id =
    findAccountId(record.platform, record.username) ??
    createRecord(ACCOUNT_KIND, {
      username: record.username,
      metadata_json: JSON.stringify(record.metadata),
    });
  const document = readDocument(id);
  const fields = document.fields ?? {};
  const current = fields.metadata_json
    ? JSON.parse(String(fields.metadata_json))
    : {};
  fields.metadata_json = JSON.stringify({ ...current, ...record.metadata });
  document.fields = fields;
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: 'trajectory-account',
    platform: record.platform,
    display_name:
      record.displayName ?? document.context?.display_name ?? record.username,
    active: true,
  };
  writeDocument(id, document);
  return id;
}

export function putAccount(record: {
  platform: string;
  username: string;
  password: string;
  metadata: Record<string, unknown>;
  displayName?: string;
}): string {
  const fields = {
    username: record.username,
    password: record.password,
    metadata_json: JSON.stringify(record.metadata),
  };
  const existing = findAccountId(record.platform, record.username);
  const id = existing ?? createRecord(ACCOUNT_KIND, fields);
  if (existing) writeBundle(id, fields);
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

export function updateAccount(
  id: string,
  patch: { metadata?: Record<string, any>; active?: boolean },
): boolean {
  if (!recordIds(ACCOUNT_KIND).includes(id)) return false;
  const document = readDocument(id);
  const fields = document.fields ?? {};
  const current = fields.metadata_json
    ? JSON.parse(String(fields.metadata_json))
    : {};
  if (patch.metadata)
    fields.metadata_json = JSON.stringify({ ...current, ...patch.metadata });
  document.fields = fields;
  document.context = {
    ...(document.context ?? {}),
    ...(patch.active === undefined ? {} : { active: patch.active }),
  };
  writeDocument(id, document);
  return true;
}

/** The runtime setting record for `key`, or null when none was written. */
function settingRecordId(key: string): string | null {
  if (!/^[a-z][a-z0-9_]{0,126}$/.test(key))
    throw new Error(`invalid Weles setting: ${key}`);
  return (
    recordIds(SETTING_KIND).find(
      (id) => readDocument(id).context?.setting_key === key,
    ) ?? null
  );
}

/**
 * The stored value of one Weles runtime setting, or `absent` when no setting
 * record carries `key` (the state before anything was written). A vault that
 * cannot be read, or a value that is not JSON, is an error naming the setting:
 * read as `absent` it made an unreachable vault look like an empty rate card,
 * an empty burned-proxy list or a follow-up nobody had queued yet.
 */
export function readSetting<T>(key: string, absent: T): T {
  const id = settingRecordId(key);
  if (!id) return absent;
  const raw = readDocument(id).fields?.value_json;
  if (!raw) return absent;
  try {
    return JSON.parse(String(raw)) as T;
  } catch (error) {
    throw new Error(
      `Weles setting ${key} holds no JSON value: ${(error as Error).message}`,
    );
  }
}

export function writeSetting<T>(key: string, value: T): void {
  const fields = { value_json: JSON.stringify(value) };
  const existing = settingRecordId(key);
  const id = existing ?? createRecord(SETTING_KIND, fields);
  if (existing) writeBundle(id, fields);
  const document = readDocument(id);
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: 'runtime-setting',
    setting_key: key,
  };
  writeDocument(id, document);
}
