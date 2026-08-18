// CRUD helper for service_subscriptions through the launcher-resolved
// exact weles-database item/client.

const DATABASE_URL = process.env.WELES_DATABASE_URL;
const DATABASE_TOKEN = process.env.WELES_DATABASE_TOKEN;

function apiHeaders() {
  return {
    'apikey': DATABASE_TOKEN,
    'Authorization': `Bearer ${DATABASE_TOKEN}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

function checkEnv() {
  if (!DATABASE_URL || !DATABASE_TOKEN) {
    throw new Error('Set WELES_DATABASE_URL and WELES_DATABASE_TOKEN');
  }
}

export async function listSubscriptions({ service, status, provider, account } = {}) {
  checkEnv();
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'updated_at.desc');
  if (service) params.set('service_name', `eq.${service}`);
  if (status) params.set('status', `eq.${status}`);
  if (provider) params.set('provider', `eq.${provider}`);
  if (account) params.set('account_identifier', `eq.${account}`);
  const res = await fetch(`${DATABASE_URL}/rest/v1/service_subscriptions?${params.toString()}`, {
    method: 'GET',
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`listSubscriptions failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function upsertSubscription(row) {
  checkEnv();
  const body = {
    service_name: row.service_name,
    provider: row.provider,
    account_identifier: row.account_identifier,
    status: row.status ?? 'unknown',
    plan: row.plan ?? null,
    monthly_cost_usd: row.monthly_cost_usd ?? null,
    expires_at: row.expires_at ?? null,
    last_verified_at: row.last_verified_at ?? new Date().toISOString(),
    metadata: row.metadata ?? {},
  };
  if (row.service_credential_id) body.service_credential_id = row.service_credential_id;

  const res = await fetch(
    `${DATABASE_URL}/rest/v1/service_subscriptions?on_conflict=service_name,provider,account_identifier`,
    {
    method: 'POST',
    headers: { ...apiHeaders(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`upsertSubscription failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function updateSubscription(id, patch) {
  checkEnv();
  const res = await fetch(`${DATABASE_URL}/rest/v1/service_subscriptions?id=eq.${id}`, {
    method: 'PATCH',
    headers: apiHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`updateSubscription failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function deleteSubscription(id) {
  checkEnv();
  const res = await fetch(`${DATABASE_URL}/rest/v1/service_subscriptions?id=eq.${id}`, {
    method: 'DELETE',
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`deleteSubscription failed: ${res.status} ${await res.text()}`);
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
