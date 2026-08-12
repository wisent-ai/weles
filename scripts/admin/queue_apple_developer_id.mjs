#!/usr/bin/env node
// Queue one Developer ID Application certificate run, with its authorization.
//
//   WELES_DATABASE_URL=... WELES_DATABASE_TOKEN=... \
//   APPLE_ACCOUNT_ID=<uuid> APPLE_CSR_PATH=<path on the worker host> \
//   APPLE_CERTIFICATE_PATH=<path on the worker host> \
//   APPLE_EXECUTION_HOST=<os.hostname() of the worker> \
//   node scripts/admin/queue_apple_developer_id.mjs
//
// The row carries no capability envelope. The worker resolves one itself for
// every action in APPLE_GUARDED_ACTIONS, claiming the authorization with a lease
// first, which is why a queued row only needs to name the guard.
//
// One authorization is active per account at a time, so an expired-but-open
// guard blocks the next one. This closes such a guard before opening its own,
// and records why, rather than leaving an operator to discover the constraint
// from a duplicate-key error.

import { randomUUID } from 'node:crypto';

const url = process.env.WELES_DATABASE_URL ?? '';
const token = process.env.WELES_DATABASE_TOKEN ?? '';
const accountId = process.env.APPLE_ACCOUNT_ID ?? '';
const csrPath = process.env.APPLE_CSR_PATH ?? '';
const certificatePath = process.env.APPLE_CERTIFICATE_PATH ?? '';
const executionHost = process.env.APPLE_EXECUTION_HOST ?? '';
const executionAgent = process.env.APPLE_EXECUTION_AGENT ?? 'weles-worker';
const reason = process.env.APPLE_AUTH_REASON ?? 'Developer ID Application certificate for Wisent desktop distribution';
const createdBy = process.env.APPLE_AUTH_CREATED_BY ?? 'lukasz.bartoszcze@wisent.ai';

for (const [name, value] of [
  ['WELES_DATABASE_URL', url], ['WELES_DATABASE_TOKEN', token],
  ['APPLE_ACCOUNT_ID', accountId], ['APPLE_CSR_PATH', csrPath],
  ['APPLE_CERTIFICATE_PATH', certificatePath], ['APPLE_EXECUTION_HOST', executionHost],
]) {
  if (!value) throw new Error(`${name} is required`);
}

const headers = {
  apikey: token,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function rest(method, path, body) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const now = new Date();
const nowIso = now.toISOString();
const expiryMinutes = Number(process.env.APPLE_AUTH_EXPIRY_MINUTES ?? '120');
const expiresIso = new Date(now.getTime() + expiryMinutes * 60_000).toISOString();

const open = await rest('GET', `apple_auth_submit_guards?account_id=eq.${accountId}&state=neq.closed&select=id,state,expires_at`);
for (const guard of open ?? []) {
  await rest('PATCH', `apple_auth_submit_guards?id=eq.${guard.id}`, {
    state: 'closed',
    closed_at: nowIso,
    observable_postcondition: 'Superseded by a newly requested authorization; no password was submitted under this one',
  });
  console.log(`closed prior guard ${guard.id} (was ${guard.state}, expired ${guard.expires_at})`);
}

const guardId = randomUUID();
await rest('POST', 'apple_auth_submit_guards', {
  id: guardId,
  provider: 'apple',
  account_id: accountId,
  state: 'authorized',
  reason,
  created_by: createdBy,
  execution_host: executionHost,
  execution_agent: executionAgent,
  authorized_at: nowIso,
  expires_at: expiresIso,
});

const [row] = await rest('POST', 'account_action_logs', {
  action: 'apple_create_developer_id',
  platform: 'apple',
  account_id: accountId,
  status: 'queued',
  scheduled_at: nowIso,
  params: {
    apple_auth_guard_id: guardId,
    apple_execution_host: executionHost,
    apple_execution_agent: executionAgent,
    apple_csr_path: csrPath,
    apple_certificate_path: certificatePath,
  },
});

await rest('PATCH', `apple_auth_submit_guards?id=eq.${guardId}`, { action_log_id: row.id });

console.log(JSON.stringify({ guard_id: guardId, action_log_id: row.id, expires_at: expiresIso }, null, ' '));
