#!/usr/bin/env node
// Queue one Developer ID Application certificate run with the same fail-closed
// authorization and one-use capability envelope as every Apple password flow.

import { spawnSync } from 'node:child_process';

const CAPABILITY_ID_PATTERN = /^[0-9a-f]{64}$/;
const home = process.env.HOME ?? '';
const skarbiecUrl = process.env.WC_SKARBIEC_URL ?? 'http://127.0.0.1:8895';
const acquisitionScopes = process.env.SKARBIEC_ACQUISITION_SCOPES_FILE
  ?? `${home}/weles/scripts/worker/deploy/skarbiec-acquisition-scopes.conf`;
const acquisitionHelper = process.env.SKARBIEC_ACQUIRE_HELPER
  ?? `${home}/weles/scripts/worker/deploy/skarbiec-acquire.mjs`;

function acquireStartupField(consumer, item, field) {
  const result = spawnSync(process.execPath, [
    acquisitionHelper, skarbiecUrl, acquisitionScopes, consumer, item, field,
  ], {
    cwd: home,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim().slice(0, 300) ?? `exit ${result.status}`;
    throw new Error(`Skarbiec acquisition failed for ${item}/${field}: ${detail}`);
  }
  const value = result.stdout.trim();
  if (!value) throw new Error(`Skarbiec returned an empty ${item}/${field}`);
  return value;
}

const url = process.env.WELES_DATABASE_URL
  ?? acquireStartupField('weles-database-url-bootstrap', 'weles-database', 'url');
const token = process.env.WELES_DATABASE_TOKEN
  ?? acquireStartupField('weles-database-service-role-bootstrap', 'weles-database', 'service_role_key');
const accountId = process.env.APPLE_ACCOUNT_ID ?? '';
const csrPath = process.env.APPLE_CSR_PATH ?? '';
const certificatePath = process.env.APPLE_CERTIFICATE_PATH ?? '';
const executionHost = process.env.APPLE_EXECUTION_HOST ?? '';
const executionAgent = process.env.APPLE_EXECUTION_AGENT ?? 'weles-worker';
const reason = process.env.APPLE_AUTH_REASON ?? 'Developer ID Application certificate for Wisent desktop distribution';
const createdBy = process.env.APPLE_AUTH_CREATED_BY ?? 'lukasz.bartoszcze@wisent.ai';
const skarbiecBin = process.env.SKARBIEC_BIN ?? `${home}/.stado/bin/skarbiec`;

for (const [name, value] of [
  ['WELES_DATABASE_URL', url], ['WELES_DATABASE_TOKEN', token],
  ['APPLE_ACCOUNT_ID', accountId], ['APPLE_CSR_PATH', csrPath],
  ['APPLE_CERTIFICATE_PATH', certificatePath], ['APPLE_EXECUTION_HOST', executionHost],
  ['HOME', home],
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
  const response = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function rpc(name, body) {
  const payload = await rest('POST', `rpc/${name}`, body);
  if (!Array.isArray(payload) || payload.length !== 1 || typeof payload[0]?.id !== 'string') {
    throw new Error(`${name} returned no unique guard row`);
  }
  return payload[0];
}

function runCapabilityCommand(args) {
  const result = spawnSync(skarbiecBin, args, {
    cwd: home,
    env: {
      ...process.env,
      SKARBIEC_VAULT_FILE: process.env.SKARBIEC_VAULT_FILE ?? `${home}/.stado/skarbiec.vault.json`,
      SKARBIEC_CAPABILITY_FILE: process.env.SKARBIEC_CAPABILITY_FILE ?? `${home}/.stado/weles-api-capabilities.json`,
      SKARBIEC_CAPABILITY_ROUTES_FILE: process.env.SKARBIEC_CAPABILITY_ROUTES_FILE ?? `${home}/.stado/weles-api-capability-routes.json`,
    },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim().slice(0, 300) ?? `exit ${result.status}`;
    throw new Error(`Local Skarbiec capability command failed closed: ${detail}`);
  }
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { throw new Error('Local Skarbiec capability command returned invalid JSON'); }
  return payload;
}

function issueCapability(purpose, resource, guardId, expiresAtMs) {
  const ttlSeconds = Math.floor((expiresAtMs - Date.now()) / 1000);
  const payload = runCapabilityCommand([
    'capability-issue', '--agent', executionAgent, '--purpose', purpose, '--resource', resource,
    '--target', 'weles', '--ttl', String(ttlSeconds), '--max-uses', '1',
    '--authorization-id', guardId,
  ]);
  if (payload?.status !== 'issued' || typeof payload.capability_id !== 'string'
      || !CAPABILITY_ID_PATTERN.test(payload.capability_id)) {
    throw new Error('Local Skarbiec returned an invalid capability identifier');
  }
  return payload.capability_id;
}

function cancelCapability(capabilityId, guardId) {
  const payload = runCapabilityCommand([
    'capability-cancel', '--agent', executionAgent, '--capability-id', capabilityId,
    '--authorization-id', guardId,
  ]);
  if (payload?.status !== 'cancelled') throw new Error('Local capability cancellation was not acknowledged');
}

const now = new Date();
const expiryMinutes = Number(process.env.APPLE_AUTH_EXPIRY_MINUTES ?? '60');
if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 60) {
  throw new Error('APPLE_AUTH_EXPIRY_MINUTES must be an integer from 1 to 60');
}
const expiresIso = new Date(now.getTime() + expiryMinutes * 60_000).toISOString();

const open = await rest(
  'GET',
  `apple_auth_submit_guards?account_id=eq.${accountId}&state=neq.closed&select=id,state,attempt_count,expires_at`,
);
for (const guard of open ?? []) {
  if (guard.attempt_count !== 0) {
    throw new Error(`active Apple authorization ${guard.id} may have submitted a password`);
  }
  await rpc('cancel_apple_auth_submit_guard', {
    p_guard_id: guard.id,
    p_reason: 'Superseded before password submission by a newly requested Developer ID authorization',
  });
  console.log(`closed prior guard ${guard.id} (was ${guard.state}, expired ${guard.expires_at})`);
}

const guard = await rpc('authorize_apple_auth_submit_guard', {
  p_account_id: accountId,
  p_created_by: createdBy,
  p_reason: reason,
  p_expires_at: expiresIso,
  p_execution_host: executionHost,
  p_execution_agent: executionAgent,
});
const guardId = guard.id;
const issued = [];
let actionLogId = null;

try {
  const [row] = await rest('POST', 'account_action_logs', {
    action: 'apple_create_developer_id',
    platform: 'apple',
    account_id: accountId,
    status: 'pending_review',
    scheduled_at: now.toISOString(),
    params: {
      apple_auth_guard_id: guardId,
      apple_execution_host: executionHost,
      apple_execution_agent: executionAgent,
      apple_csr_path: csrPath,
      apple_certificate_path: certificatePath,
    },
  });
  actionLogId = row.id;

  await rpc('bind_apple_auth_submit_guard', {
    p_guard_id: guardId,
    p_account_id: accountId,
    p_action_log_id: actionLogId,
  });

  issued.push(issueCapability('weles.browser.fill', 'origin:https://idmsa.apple.com/email', guardId, Date.parse(expiresIso)));
  issued.push(issueCapability('weles.browser.fill', 'origin:https://idmsa.apple.com/password', guardId, Date.parse(expiresIso)));
  issued.push(issueCapability('weles.apple.2fa', `challenge:apple/${guardId}`, guardId, Date.parse(expiresIso)));
  if (new Set(issued).size !== 3) throw new Error('Local Skarbiec returned duplicate capability identifiers');

  await rpc('store_apple_auth_capability_envelope', {
    p_guard_id: guardId,
    p_account_id: accountId,
    p_action_log_id: actionLogId,
    p_email_capability_id: issued[0],
    p_password_capability_id: issued[1],
    p_two_factor_capability_id: issued[2],
  });
  await rest('PATCH', `account_action_logs?id=eq.${actionLogId}`, {
    status: 'queued',
    scheduled_at: new Date().toISOString(),
  });
  console.log(JSON.stringify({ guard_id: guardId, action_log_id: actionLogId, expires_at: expiresIso }, null, ' '));
} catch (error) {
  if (actionLogId) {
    await rest('PATCH', `account_action_logs?id=eq.${actionLogId}`, {
      status: 'failed',
      error: error instanceof Error ? error.message.slice(0, 500) : 'Developer ID authorization failed',
      completed_at: new Date().toISOString(),
    }).catch(() => {});
  }
  for (const capabilityId of issued) {
    try { cancelCapability(capabilityId, guardId); } catch {}
  }
  await rpc('cancel_apple_auth_submit_guard', {
    p_guard_id: guardId,
    p_reason: 'Developer ID authorization setup failed before password submission',
  }).catch(() => {});
  throw error;
}
