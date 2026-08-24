import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WelesAccountRecord {
  id: string;
  platform: string;
  username: string;
  password: string;
  active: boolean;
  metadata: Record<string, any>;
  context: Record<string, any>;
}

const SKARBIEC = process.env.SKARBIEC_BIN || join(homedir(), '.stado', 'bin', 'skarbiec');
const VAULT = process.env.SKARBIEC_VAULT_FILE || join(homedir(), '.stado', 'skarbiec.vault.json');
const STADO = process.env.WELES_STADO_BIN || join(homedir(), '.stado', 'bin', 'stado');
const ACCOUNT_ID = /^weles-[a-z0-9][a-z0-9-]{0,126}-account$/;

function skarbiec(args: string[], input?: string): string {
  return execFileSync(SKARBIEC, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, SKARBIEC_VAULT_FILE: VAULT },
  });
}

function itemIds(kind?: string): string[] {
  const rows = JSON.parse(skarbiec(['list'])) as Array<Record<string, any>>;
  return rows.filter((row) => !row.deleted && (!kind || row.kind === kind))
    .map((row) => String(row.name ?? row.id ?? ''))
    .filter(Boolean);
}

function readDocument(id: string): Record<string, any> {
  return JSON.parse(skarbiec(['get', id])) as Record<string, any>;
}

function writeDocument(id: string, document: Record<string, any>): void {
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

export function listAccounts(platform?: string): WelesAccountRecord[] {
  return itemIds().filter((id) => ACCOUNT_ID.test(id)).map((id) => {
    const document = readDocument(id);
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
  }).filter((account) => account.active && (!platform || account.platform === platform));
}

export function getAccount(id: string): WelesAccountRecord | null {
  if (!ACCOUNT_ID.test(id)) return null;
  try { return listAccounts().find((account) => account.id === id) ?? null; } catch { return null; }
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

export function enqueueAction(action: string, accountItem: string, params: Record<string, unknown>): string {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(action)) throw new Error(`invalid Weles action: ${action}`);
  if (accountItem && !ACCOUNT_ID.test(accountItem)) throw new Error('invalid Weles account item');
  const payload = Buffer.from(JSON.stringify({ action, accountItem, params }), 'utf8').toString('base64url');
  const runner = join(homedir(), 'weles', 'scripts', 'worker', 'stado-action-runner.mjs');
  const command = `${process.execPath} ${runner} ${payload}`;
  const result = spawnSync(STADO, ['submit', command], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Stado refused ${action}: ${(result.stderr || '').trim()}`);
  const id = String(result.stdout).match(/\b[0-9a-f]{8}\b/i)?.[0];
  if (!id) throw new Error(`Stado returned no job id for ${action}`);
  return id;
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

function runItemId(runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,126}$/.test(runId)) throw new Error('invalid Weles run id');
  return `weles-run-${runId.toLowerCase()}`;
}

export function readRunRecord<T>(runId: string): T | null {
  try {
    const raw = readDocument(runItemId(runId)).fields?.value_json;
    return raw ? JSON.parse(String(raw)) as T : null;
  } catch {
    return null;
  }
}
