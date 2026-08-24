import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const SKARBIEC = process.env.SKARBIEC_BIN ?? path.join(HOME, '.stado', 'bin', 'skarbiec');
const VAULT = process.env.SKARBIEC_VAULT_FILE ?? path.join(HOME, '.stado', 'skarbiec.vault.json');
const SAFE_ITEM = /^weles-[a-z0-9][a-z0-9-]{0,126}-account$/;

function run(args, input) {
  return execFileSync(SKARBIEC, args, {
    input,
    encoding: 'utf8',
    env: { ...process.env, SKARBIEC_VAULT_FILE: VAULT },
  });
}

function requireItem(id) {
  if (!SAFE_ITEM.test(String(id))) throw new Error('invalid Weles account item id');
  return String(id);
}

export function accountItemId(platform, username) {
  const slug = String(username).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return requireItem(`weles-${String(platform).toLowerCase()}-${slug}-account`);
}

export function readWelesRecord(id) {
  if (!/^weles-[a-z0-9][a-z0-9-]{0,190}$/.test(String(id))) {
    throw new Error('invalid Weles Skarbiec record id');
  }
  return JSON.parse(run(['get', String(id)]));
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
export function listAccounts(platform = '') {
  const rows = JSON.parse(run(['list']));
  return rows
    .filter((row) => !row.deleted)
    .map((row) => String(row.name ?? row.id ?? ''))
    .filter((id) => SAFE_ITEM.test(id))
    .map((id) => readAccount(id))
    .filter((account) => {
      const active = account.document.context?.active !== false;
      return active && (!platform || account.platform === platform);
    });
}

export function findAccount(platform, username) {
  const normalized = String(username ?? '').trim().toLowerCase();
  return listAccounts(platform).find((account) =>
    account.username.trim().toLowerCase() === normalized) ?? null;
}
export function writeRunRecord(runId, value) {
  const clean = String(runId);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,126}$/.test(clean)) throw new Error('invalid Weles run id');
  const id = `weles-run-${clean.toLowerCase()}`;
  run(['set', id, '--type', 'bundle', `value_json=${JSON.stringify(value)}`]);
  const document = readWelesRecord(id);
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: 'trajectory-run',
    run_id: clean,
  };
  run(['set-json', id], JSON.stringify(document));
  return id;
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

export function writeAccount({ id, platform, username, password, metadata, displayName = '' }) {
  const item = requireItem(id);
  const fields = [
    `username=${String(username)}`,
    `password=${String(password)}`,
    `metadata_json=${JSON.stringify(metadata ?? {})}`,
  ];
  run(['set', item, '--type', 'bundle', ...fields]);
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
  const metadata = typeof update === 'function'
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
