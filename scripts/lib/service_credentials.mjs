// REST helper for Weles service_credentials through the launcher-resolved
// exact weles-database item/client.

import { readFileSync } from 'node:fs';
import { randomBytes, sign } from 'node:crypto';

// Consolidated credential source: entitlements-router is the single source of
// truth. When WELES_SERVICE_CREDENTIALS_JSON (inline JSON array) or
// WELES_SERVICE_CREDENTIALS_FILE (path to one) is set, reads resolve from the
// same rows the router holds — so a credential added there is usable here with
// no Supabase read. Unconfigured -> null (caller uses Supabase). Configured but
// unreadable/malformed -> throws (a misconfig must be loud, never silent).
let _consolidated;
function consolidatedRows() {
  if (_consolidated !== undefined) return _consolidated;
  const inline = process.env.WELES_SERVICE_CREDENTIALS_JSON;
  const file = process.env.WELES_SERVICE_CREDENTIALS_FILE;
  let raw = null;
  if (inline && inline.trim()) raw = inline;
  else if (file) raw = readFileSync(file, 'utf8');
  if (!raw) { _consolidated = null; return null; }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`WELES_SERVICE_CREDENTIALS_* is configured but not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('WELES_SERVICE_CREDENTIALS_* is configured but is not a JSON array');
  _consolidated = parsed;
  return parsed;
}

export function consolidatedById(id) {
  const rows = consolidatedRows();
  if (!rows) return null;
  return rows.find((row) => row && row.id === id) ?? null;
}

export function consolidatedByEmailWithPassword(email) {
  const rows = consolidatedRows();
  if (!rows) return null;
  const needle = String(email).toLowerCase();
  return rows.find((row) => row && String(row.login_email ?? '').toLowerCase() === needle && Boolean(row.login_password)) ?? null;
}

const DATABASE_URL = process.env.WELES_DATABASE_URL;
const DATABASE_TOKEN = process.env.WELES_DATABASE_TOKEN;

function checkEnv() {
  if (!DATABASE_URL || !DATABASE_TOKEN) {
    throw new Error('Set WELES_DATABASE_URL and WELES_DATABASE_TOKEN');
  }
}

function headers(extra = {}) {
  return {
    apikey: DATABASE_TOKEN,
    Authorization: `Bearer ${DATABASE_TOKEN}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function request(path, init = {}) {
  checkEnv();
  const res = await fetch(`${DATABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: headers(init.headers || {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
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
  const query = new URLSearchParams();
  query.set('select', 'id,category,display_name,login_method,login_email,updated_at,metadata');
  query.set('order', 'display_name.asc');
  if (search) {
    query.set(
      'or',
      `(${search.split(',').map((term) => `display_name.ilike.*${term.trim()}*`).join(',')})`
    );
  }
  const rows = await request(`service_credentials?${query.toString()}`);
  return rows.map(redacted);
}

export async function getCredential(id) {
  const consolidated = consolidatedById(id);
  if (consolidated) return consolidated;
  const rows = await request(
    `service_credentials?id=eq.${encodeURIComponent(id)}&select=*`
  );
  return rows[0] || null;
}

export async function patchCredential(id, patch) {
  return request(`service_credentials?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
}

export async function upsertCredential(row) {
  return request('service_credentials?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
}

export async function ensureKimiGoogleSso({
  id = 'kimi-lukasz-google-sso',
  email = 'lukasz.bartoszcze@gmail.com',
  sourceCredentialId,
} = {}) {
  const source = sourceCredentialId ? await getCredential(sourceCredentialId) : null;
  const row = {
    id,
    category: 'ai_cli',
    display_name: 'Kimi',
    login_method: 'google_sso',
    login_email: email,
    login_password: source?.login_password || null,
    metadata: {
      account_identifier: email,
      configured_for: 'kimi-code',
      source_credential_id: source?.id || null,
      updated_by: 'scripts/lib/service_credentials.mjs ensure-kimi-google-sso',
      updated_at: new Date().toISOString(),
    },
  };
  return upsertCredential(row);
}

function skarbiecConfig() {
  const url = process.env.SKARBIEC_URL;
  const consumer = process.env.SKARBIEC_CONSUMER;
  const workloadId = process.env.SKARBIEC_WORKLOAD_ID;
  const privateKeyFile = process.env.SKARBIEC_WORKLOAD_PRIVATE_KEY_FILE;
  if (!url || !consumer || !workloadId || !privateKeyFile) {
    throw new Error(
      'Skarbiec acquisition requires SKARBIEC_URL, SKARBIEC_CONSUMER, SKARBIEC_WORKLOAD_ID, and SKARBIEC_WORKLOAD_PRIVATE_KEY_FILE'
    );
  }
  return {
    url: url.replace(/\/$/, ''),
    consumer,
    workloadId,
    privateKey: readFileSync(privateKeyFile),
  };
}

async function acquireSkarbiecField(item, field, { optional = false } = {}) {
  const cfg = skarbiecConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(24).toString('hex');
  const proof = JSON.stringify([cfg.consumer, item, field, cfg.workloadId, timestamp, nonce]);
  const signature = sign(null, Buffer.from(proof), cfg.privateKey).toString('hex');
  const issue = await fetch(`${cfg.url}/v1/acquisitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Consumer': cfg.consumer },
    body: JSON.stringify({
      id: item,
      field,
      workload_id: cfg.workloadId,
      workload_timestamp: timestamp,
      workload_nonce: nonce,
      workload_signature: signature,
    }),
  });
  if (!issue.ok) {
    if (optional && (issue.status === 401 || issue.status === 404)) return null;
    throw new Error(`Skarbiec acquisition issue ${item}#${field} -> ${issue.status}`);
  }
  const issued = await issue.json();
  const consume = await fetch(`${cfg.url}/v1/acquisitions/read`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Consumer': cfg.consumer,
      Authorization: `Bearer ${issued.token}`,
    },
    body: JSON.stringify({ id: item, field }),
  });
  if (!consume.ok) {
    if (optional && (consume.status === 401 || consume.status === 404)) return null;
    throw new Error(`Skarbiec acquisition read ${item}#${field} -> ${consume.status}`);
  }
  return (await consume.json()).value;
}

// Resolves a canonical Skarbiec login through workload-bound, exact-field,
// single-use acquisitions. No database credential row or bearer grant enters
// the browser process.
export async function resolveAdminSecrets(credentialId) {
  const [username, password, totp, context] = await Promise.all([
    acquireSkarbiecField(credentialId, 'username'),
    acquireSkarbiecField(credentialId, 'password'),
    acquireSkarbiecField(credentialId, 'totp_secret', { optional: true }),
    acquireSkarbiecField(credentialId, 'context', { optional: true }),
  ]);
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new Error(`Skarbiec login ${credentialId} returned non-text username or password`);
  }
  const secrets = { ADMIN_EMAIL: username, ADMIN_PASSWORD: password };
  if (typeof totp === 'string' && totp) secrets.ADMIN_TOTP = totp;
  const sessionLabel =
    context && typeof context === 'object' && typeof context.session_label === 'string'
      ? context.session_label
      : null;
  return {
    session_label: sessionLabel,
    placeholders: Object.keys(secrets),
    secrets,
  };
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
    console.error('Usage: node scripts/lib/service_credentials.mjs list [term,term] | patch <id> <json> | ensure-kimi-google-sso [source_credential_id] [email]');
    process.exit(1);
  }
}
