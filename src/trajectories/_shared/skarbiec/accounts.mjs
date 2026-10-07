import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { activeSkarbiecBinary } from '../../../_shared/skarbiec-runtime.mjs';

const HOME = os.homedir();
let resolvedSkarbiecBinary;
const VAULT =
  process.env.SKARBIEC_VAULT_FILE ??
  path.join(HOME, '.stado', 'skarbiec.vault.json');
// Weles marks each record with the kind it is (Skarbiec namespace
// weles:record:<kind>) and finds one by that tag and its own context; an
// item's id is random and nothing reads meaning out of it.
const RECORD_TAG_PREFIX = 'weles:record:';
const ACCOUNT_KIND = 'trajectory-account';
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;

function run(args, input) {
  return execFileSync(
    (resolvedSkarbiecBinary ??= activeSkarbiecBinary()),
    args,
    {
      input,
      encoding: 'utf8',
      env: { ...process.env, SKARBIEC_VAULT_FILE: VAULT },
    },
  );
}

function requireItem(id) {
  if (!ITEM_ID.test(String(id)))
    throw new Error('invalid Weles Skarbiec record id');
  return String(id);
}

/** The ids of the live items marked as Weles records of `kind`. */
function recordIds(kind) {
  const tag = `${RECORD_TAG_PREFIX}${kind}`;
  return JSON.parse(run(['list']))
    .filter(
      (row) =>
        !row.deleted && Array.isArray(row.tags) && row.tags.includes(tag),
    )
    .map((row) => String(row.id ?? row.name ?? ''))
    .filter(Boolean);
}

/**
 * Write a record of `kind` under `id` as an `itemKind` payload holding
 * exactly `fields`, tagging it when it is new. The payload travels on
 * standard input, so no credential value is ever in an argv.
 */
function setRecord(kind, id, itemKind, fields) {
  const fresh = !recordIds(kind).includes(id);
  run(
    [
      'set-json',
      id,
      '--type',
      itemKind,
      ...(fresh ? ['--tags', `${RECORD_TAG_PREFIX}${kind}`] : []),
    ],
    JSON.stringify({
      schema: 'skarbiec.item.v2',
      kind: itemKind,
      fields,
      context: {},
    }),
  );
}

/**
 * The account of `platform` signed in as `username` — active or not — or a
 * new random id for one that does not exist yet.
 */
export function accountItemFor(platform, username) {
  const wanted = String(username).trim().toLowerCase();
  const existing = recordIds(ACCOUNT_KIND)
    .map((id) => readAccount(id))
    .find(
      (account) =>
        account.platform === String(platform) &&
        account.username.trim().toLowerCase() === wanted,
    );
  return existing?.id ?? randomUUID().replaceAll('-', '');
}

export function readWelesRecord(id) {
  return JSON.parse(run(['get', requireItem(id)]));
}

export function updateWelesRecord(id, contextPatch = {}, fieldPatch = {}) {
  const document = readWelesRecord(id);
  document.context = { ...(document.context ?? {}), ...contextPatch };
  document.fields = { ...(document.fields ?? {}), ...fieldPatch };
  run(['set-json', String(id)], JSON.stringify(document));
  return true;
}
export function findWelesRecordId(predicate) {
  const rows = JSON.parse(run(['list']));
  for (const row of rows) {
    if (row.deleted) continue;
    const id = String(row.name ?? row.id ?? '');
    if (!id) continue;
    const document = readWelesRecord(id);
    if (predicate(document, id)) return id;
  }
  return null;
}

function recordPayload(document, fieldName) {
  const raw = document.fields?.[fieldName] ?? document.fields?.value_json;
  return raw ? JSON.parse(String(raw)) : { ...(document.context ?? {}) };
}

export function accountCharacter(account) {
  const embedded = account?.metadata?.character;
  if (embedded && typeof embedded === 'object') return embedded;
  const characterId = String(account?.metadata?.character_id ?? '');
  if (!characterId) return null;
  const document = readWelesRecord(characterId);
  return { id: characterId, ...recordPayload(document, 'character_json') };
}

export function findProduct(productId) {
  const wanted = String(productId ?? '').trim();
  if (!wanted) return null;
  const id = findWelesRecordId((document, recordId) => {
    const context = document.context ?? {};
    return (
      context.record_kind === 'product' &&
      (recordId === wanted || String(context.product_id ?? '') === wanted)
    );
  });
  if (!id) return null;
  const document = readWelesRecord(id);
  return { id, ...recordPayload(document, 'product_json') };
}

export function writeServiceCredentials(service, { username, password }) {
  const kind = 'service-credential';
  const id =
    recordIds(kind).find(
      (recordId) =>
        readWelesRecord(recordId).context?.service === String(service),
    ) ?? randomUUID().replaceAll('-', '');
  setRecord(kind, id, 'login', {
    username: String(username),
    password: String(password),
  });
  const document = readWelesRecord(id);
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: kind,
    service: String(service),
  };
  run(['set-json', id], JSON.stringify(document));
  return id;
}

export function writeDomainStatus(domain, status) {
  const kind = 'email-domain-status';
  const id =
    recordIds(kind).find(
      (recordId) => readWelesRecord(recordId).fields?.domain === String(domain),
    ) ?? randomUUID().replaceAll('-', '');
  setRecord(kind, id, 'bundle', {
    domain: String(domain),
    status: String(status),
  });
  const document = readWelesRecord(id);
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: kind,
    updated_at: new Date().toISOString(),
  };
  run(['set-json', id], JSON.stringify(document));
  return id;
}

// The receiving probe last sent to `domain`, kept in its status record so the
// next health run looks for exactly that mail in the inbox.
export function writeDomainProbe(domain, marker) {
  const kind = 'email-domain-status';
  let id = recordIds(kind).find(
    (recordId) => readWelesRecord(recordId).fields?.domain === String(domain),
  );
  if (!id) {
    id = randomUUID().replaceAll('-', '');
    setRecord(kind, id, 'bundle', {
      domain: String(domain),
      status: 'unprobed',
    });
  }
  const document = readWelesRecord(id);
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: kind,
    probe_marker: String(marker),
    probe_sent_at: new Date().toISOString(),
  };
  run(['set-json', id], JSON.stringify(document));
}

// domain -> { marker, sentAt } for every domain with a recorded probe.
export function readDomainProbes() {
  return Object.fromEntries(
    recordIds('email-domain-status')
      .map((id) => readWelesRecord(id))
      .filter(
        (document) => document.context?.probe_marker && document.fields?.domain,
      )
      .map((document) => [
        document.fields.domain,
        {
          marker: document.context.probe_marker,
          sentAt: document.context.probe_sent_at,
        },
      ]),
  );
}
export function listAccounts(platform = '') {
  return recordIds(ACCOUNT_KIND)
    .map((id) => readAccount(id))
    .filter((account) => {
      const active = account.document.context?.active !== false;
      return active && (!platform || account.platform === platform);
    });
}

export function findAccount(platform, username) {
  const normalized = String(username ?? '')
    .trim()
    .toLowerCase();
  return (
    listAccounts(platform).find(
      (account) => account.username.trim().toLowerCase() === normalized,
    ) ?? null
  );
}

export function readAccount(id) {
  const document = JSON.parse(run(['get', requireItem(id)]));
  const fields = document.fields ?? {};
  return {
    id,
    platform: document.context?.platform ?? '',
    username: fields.username ?? '',
    password: fields.password ?? '',
    metadata: fields.metadata_json ? JSON.parse(fields.metadata_json) : {},
    document,
  };
}

export function writeAccount({
  id,
  platform,
  username,
  password,
  metadata,
  displayName = '',
}) {
  const item = requireItem(id);
  setRecord(ACCOUNT_KIND, item, 'bundle', {
    username: String(username),
    password: String(password),
    metadata_json: JSON.stringify(metadata ?? {}),
  });
  const document = JSON.parse(run(['get', item]));
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: 'trajectory-account',
    platform: String(platform),
    display_name: String(displayName || username),
  };
  run(['set-json', item], JSON.stringify(document));
  return item;
}

export function replaceAccountMetadata(id, metadata) {
  const account = readAccount(id);
  writeAccount({
    id: account.id,
    platform: account.platform,
    username: account.username,
    password: account.password,
    metadata,
    displayName: account.document.context?.display_name,
  });
}

export function updateAccountMetadata(id, update) {
  const account = readAccount(id);
  const metadata =
    typeof update === 'function'
      ? update(account.metadata)
      : { ...account.metadata, ...(update ?? {}) };
  writeAccount({
    id: account.id,
    platform: account.platform,
    username: account.username,
    password: account.password,
    metadata,
    displayName: account.document.context?.display_name,
  });
  return metadata;
}

export function updateAccountPassword(id, password, metadataPatch = {}) {
  const account = readAccount(id);
  writeAccount({
    id: account.id,
    platform: account.platform,
    username: account.username,
    password,
    metadata: { ...account.metadata, ...metadataPatch },
    displayName: account.document.context?.display_name,
  });
}
