// CRUD helper for Weles subscription records in Skarbiec.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { activeSkarbiecBinary } from '../_shared/skarbiec-runtime.mjs';

const SKARBIEC = activeSkarbiecBinary();
const VAULT = process.env.SKARBIEC_VAULT_FILE ?? join(homedir(), '.stado', 'skarbiec.vault.json');
const run = (args, input) => execFileSync(SKARBIEC, args, {
  input,
  encoding: 'utf8',
  env: { ...process.env, SKARBIEC_VAULT_FILE: VAULT },
});
const itemId = (row) => {
  const slug = [row.service_name, row.provider, row.account_identifier]
    .map((value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .join('-');
  const id = `weles-subscription-${slug}`;
  if (!/^weles-[a-z0-9][a-z0-9-]{0,190}$/.test(id)) throw new Error('invalid subscription item id');
  return id;
};
const read = (id) => JSON.parse(run(['get', id]));
const record = (id, document) => ({ id, ...(document.context?.subscription ?? {}) });

export async function listSubscriptions({ service, status, provider, account } = {}) {
  return JSON.parse(run(['list']))
    .filter((row) => !row.deleted)
    .map((row) => String(row.name ?? row.id ?? ''))
    .filter((id) => id.startsWith('weles-subscription-'))
    .map((id) => record(id, read(id)))
    .filter((row) => (!service || row.service_name === service)
      && (!status || row.status === status)
      && (!provider || row.provider === provider)
      && (!account || row.account_identifier === account))
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
}

export async function upsertSubscription(row) {
  const id = itemId(row);
  run(['set', id, '--type', 'bundle', `value_json=${JSON.stringify(row.metadata ?? {})}`]);
  const document = read(id);
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: 'service-subscription',
    subscription: {
      ...row,
      id,
      status: row.status ?? 'unknown',
      last_verified_at: row.last_verified_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
  run(['set-json', id], JSON.stringify(document));
  return [record(id, document)];
}

export async function updateSubscription(id, patch) {
  const document = read(id);
  document.context.subscription = {
    ...(document.context?.subscription ?? {}),
    ...patch,
    updated_at: new Date().toISOString(),
  };
  run(['set-json', id], JSON.stringify(document));
  return [record(id, document)];
}

export async function deleteSubscription(id) {
  run(['delete', String(id)]);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'list') {
    const rows = await listSubscriptions();
    console.log(JSON.stringify(rows, null, 2));
  } else if (cmd === 'upsert') {
    const row = JSON.parse(process.argv[3]);
    const rows = await upsertSubscription(row);
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log('Usage: node scripts/lib/service_subscriptions.mjs list|upsert \'<json>\'');
    process.exit(1);
  }
}
