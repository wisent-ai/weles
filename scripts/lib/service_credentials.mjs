// REST helper for Weles service_credentials.
// Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function checkEnv() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
}

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function request(path, init = {}) {
  checkEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
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
