// Weles service credential administration through Skarbiec.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { activeSkarbiecBinary } from '../_shared/skarbiec-runtime.mjs';

const SKARBIEC_BIN = activeSkarbiecBinary();
const SKARBIEC_VAULT_FILE = process.env.SKARBIEC_VAULT_FILE ?? join(homedir(), '.stado', 'skarbiec.vault.json');

function skarbiec(args, input) {
  return execFileSync(SKARBIEC_BIN, args, {
    input,
    encoding: 'utf8',
    env: { ...process.env, SKARBIEC_VAULT_FILE },
  });
}

function readItem(id) {
  return JSON.parse(skarbiec(['get', String(id)]));
}

function allCredentialItems() {
  return JSON.parse(skarbiec(['list']))
    .filter((row) => !row.deleted)
    .map((row) => String(row.name ?? row.id ?? ''))
    .filter(Boolean)
    .map((id) => {
      try { return { id, document: readItem(id) }; } catch { return null; }
    })
    .filter(({ document } = {}) => {
      const kind = String(document?.context?.record_kind ?? '');
      return kind === 'service-credential' || kind === 'service-login';
    });
}

function rowFromItem(id, document) {
  const fields = document.fields ?? {};
  const context = document.context ?? {};
  return {
    id,
    category: context.category ?? '',
    display_name: context.display_name ?? context.service ?? id,
    login_method: context.login_method ?? 'email_password',
    login_email: fields.username ?? fields.email ?? null,
    login_password: fields.password ?? null,
    metadata: context.metadata ?? {},
    updated_at: context.updated_at ?? null,
  };
}

function redacted(row) {
  return {
    id: row.id,
    category: row.category,
    display_name: row.display_name,
    login_method: row.login_method,
    login_email: row.login_email,
    updated_at: row.updated_at,
    metadata_keys: row.metadata && typeof row.metadata === 'object'
      ? Object.keys(row.metadata).sort()
      : [],
  };
}

export async function listCredentialSummaries({ search } = {}) {
  const terms = String(search ?? '').toLowerCase().split(',').map((term) => term.trim()).filter(Boolean);
  return allCredentialItems()
    .map(({ id, document }) => rowFromItem(id, document))
    .filter((row) => !terms.length || terms.some((term) => row.display_name.toLowerCase().includes(term)))
    .sort((left, right) => left.display_name.localeCompare(right.display_name))
    .map(redacted);
}

export async function getCredential(id) {
  try { return rowFromItem(String(id), readItem(id)); } catch { return null; }
}

export async function patchCredential(id, patch) {
  const document = readItem(id);
  document.fields = { ...(document.fields ?? {}) };
  document.context = { ...(document.context ?? {}) };
  if (Object.hasOwn(patch, 'login_email')) document.fields.username = patch.login_email;
  if (Object.hasOwn(patch, 'login_password')) document.fields.password = patch.login_password;
  for (const key of ['category', 'display_name', 'login_method', 'metadata']) {
    if (Object.hasOwn(patch, key)) document.context[key] = patch[key];
  }
  document.context.updated_at = new Date().toISOString();
  skarbiec(['set-json', String(id)], JSON.stringify(document));
  return [rowFromItem(String(id), document)];
}

export async function upsertCredential(row) {
  const id = String(row.id ?? '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,190}$/.test(id)) throw new Error('invalid Skarbiec credential item id');
  let document;
  try { document = readItem(id); } catch {
    skarbiec(['set', id, '--type', 'login', `username=${String(row.login_email ?? '')}`, `password=${String(row.login_password ?? '')}`]);
    document = readItem(id);
  }
  document.fields = {
    ...(document.fields ?? {}),
    username: String(row.login_email ?? document.fields?.username ?? ''),
    password: String(row.login_password ?? document.fields?.password ?? ''),
  };
  document.context = {
    ...(document.context ?? {}),
    owner: 'weles',
    record_kind: 'service-credential',
    category: row.category ?? '',
    display_name: row.display_name ?? id,
    login_method: row.login_method ?? 'email_password',
    metadata: row.metadata ?? {},
    updated_at: new Date().toISOString(),
  };
  skarbiec(['set-json', id], JSON.stringify(document));
  return [rowFromItem(id, document)];
}

export async function ensureKimiGoogleSso({
  id = 'kimi-lukasz-google-sso',
  email = 'lukasz.bartoszcze@gmail.com',
  sourceCredentialId,
} = {}) {
  const source = sourceCredentialId ? await getCredential(sourceCredentialId) : null;
  return upsertCredential({
    id,
    category: 'ai_cli',
    display_name: 'Kimi',
    login_method: 'google_sso',
    login_email: email,
    login_password: source?.login_password || '',
    metadata: {
      account_identifier: email,
      configured_for: 'kimi-code',
      source_credential_id: source?.id || null,
      updated_by: 'src/lib/service_credentials.mjs ensure-kimi-google-sso',
      updated_at: new Date().toISOString(),
    },
  });
}


if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'list') {
    const rows = await listCredentialSummaries({ search: process.argv[3] || '' });
    console.log(JSON.stringify(rows, null, 2));
  } else if (cmd === 'patch') {
    const id = process.argv[3];
    const patch = JSON.parse(process.argv[4] || '{}');
    const rows = await patchCredential(id, patch);
    console.log(JSON.stringify(rows.map(redacted), null, 2));
  } else if (cmd === 'ensure-kimi-google-sso') {
    const rows = await ensureKimiGoogleSso({
      sourceCredentialId: process.argv[3],
      email: process.argv[4] || 'lukasz.bartoszcze@gmail.com',
    });
    console.log(JSON.stringify(rows.map(redacted), null, 2));
  } else {
    console.error('Usage: node src/lib/service_credentials.mjs list [term,term] | patch <id> <json> | ensure-kimi-google-sso [source_credential_id] [email]');
    process.exit(1);
  }
}
