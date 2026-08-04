#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';

const chunks = [];
let received = Number('0');
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > Number('65536')) throw new Error('credential request exceeded size limit');
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
let request;
try {
  request = JSON.parse(bytes.toString('utf8'));
} finally {
  bytes.fill(Number('0'));
  for (const chunk of chunks) chunk.fill(Number('0'));
}
if (!request || typeof request !== 'object' || Array.isArray(request)
    || request.version !== 'skarbiec.credential-operation.v1'
    || !/^[a-f\d]{64}$/i.test(request.request_id ?? '')
    || !/^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$/.test(request.credential_id ?? '')
    || !['rotate', 'verify'].includes(request.operation)
    || request.provider !== 'microsoft'
    || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(request.account_email ?? '')
    || !['submit', 'status'].includes(request.mode)) {
  throw new Error('invalid Microsoft credential lifecycle request');
}

const databaseUrl = process.env.WELES_DATABASE_URL?.replace(/\/+$/, '') ?? '';
const databaseToken = process.env.WELES_DATABASE_TOKEN ?? '';
if (!databaseUrl || !databaseToken) throw new Error('Weles database configuration is required');
const databaseHeaders = {
  apikey: databaseToken,
  Authorization: `Bearer ${databaseToken}`,
  'Content-Type': 'application/json',
};

function safeOwnedFile(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (metadata.mode & Number.parseInt('077', Number('8'))) !== Number('0')) {
    throw new Error(`unsafe ${label}`);
  }
}

let output;
if (request.mode === 'submit') {
  const writerTokenFile = process.env.WELES_MICROSOFT_WRITER_TOKEN_FILE ?? '';
  const scopeFile = process.env.SKARBIEC_WELES_ACQUISITION_SCOPES_FILE ?? '';
  safeOwnedFile(writerTokenFile, 'Microsoft writer token file');
  safeOwnedFile(scopeFile, 'Microsoft acquisition scope catalog');
  const expectedScope = `${request.credential_id}-reader-password|${request.credential_id}|password`;
  const scopes = readFileSync(scopeFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!scopes.includes(expectedScope)) throw new Error('missing exact Microsoft credential reader scope');

  const accountsResponse = await fetch(
    `${databaseUrl}/rest/v1/social_accounts?platform=eq.microsoft&select=id,username,is_active,metadata&limit=500`,
    { headers: databaseHeaders, signal: AbortSignal.timeout(Number('30000')) },
  );
  if (!accountsResponse.ok) throw new Error(`Microsoft account lookup failed: HTTP ${accountsResponse.status}`);
  const accountEmail = request.account_email.trim().toLowerCase();
  const matches = (await accountsResponse.json()).filter((row) => {
    const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const email = String(metadata.email ?? row.username ?? '').trim().toLowerCase();
    return row.is_active === true && email === accountEmail
      && metadata.skarbiec_credential_id === request.credential_id
      && (metadata.skarbiec_tenant_id ?? null) === null;
  });
  if (matches.length !== Number('1') || !matches[0]?.id) {
    throw new Error('Microsoft account is not uniquely bound to the managed credential');
  }
  const constraints = {
    secret: request.credential_id,
    operation: request.operation,
    request_id: request.request_id,
    purpose: request.purpose,
    account_email: accountEmail,
    store_secret_target: 'skarbiec',
    vault_item_id: request.credential_id,
    vault_field: 'password',
    secret_source_origin: 'https://account.live.com',
    display_name: 'Microsoft account password',
    provider: 'microsoft',
    capabilities: ['password_rotation', 'fresh_login_verification'],
  };
  const insertResponse = await fetch(`${databaseUrl}/rest/v1/account_action_logs?select=id`, {
    method: 'POST',
    headers: { ...databaseHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({
      account_id: matches[0].id,
      action: request.operation === 'rotate' ? 'microsoft_reset_password' : 'microsoft_verify_password',
      platform: 'microsoft',
      status: 'queued',
      scheduled_at: new Date().toISOString(),
      priority: Number('1000'),
      params: {
        url: 'https://account.live.com/password/Change',
        objective: `${request.operation} the exact Microsoft account password and commit it only after fresh authentication succeeds.`,
        flow_name: 'microsoft-password-lifecycle',
        execution_mode: 'keeper_first',
        proxy: 'none',
        headless: false,
        auto_promote_trajectory: true,
        constraints,
        env: {},
      },
      tenant_id: null,
      queued_by: 'skarbiec-credential-operation',
    }),
    signal: AbortSignal.timeout(Number('30000')),
  });
  if (!insertResponse.ok) throw new Error(`Microsoft credential queue failed: HTTP ${insertResponse.status}`);
  const actionLogId = (await insertResponse.json())[0]?.id;
  if (!/^[a-f\d-]{36}$/i.test(actionLogId ?? '')) throw new Error('Weles queue returned an invalid action id');
  output = {
    status: 'operation_queued',
    operation: request.operation,
    provider: request.provider,
    actionLogId,
    vaultItemId: request.credential_id,
    message: `Microsoft password ${request.operation} queued`,
  };
} else {
  if (!/^[a-f\d-]{36}$/i.test(request.action_log_id ?? '')) {
    throw new Error('status mode requires one exact action log id');
  }
  const response = await fetch(
    `${databaseUrl}/rest/v1/account_action_logs?id=eq.${encodeURIComponent(request.action_log_id)}&select=id,status,result,error&limit=1`,
    { headers: databaseHeaders, signal: AbortSignal.timeout(Number('30000')) },
  );
  if (!response.ok) throw new Error(`Weles status lookup failed: HTTP ${response.status}`);
  const row = (await response.json())[0];
  if (!row || row.id !== request.action_log_id) throw new Error('Weles action log was not found');
  const status = ['queued', 'claimed', 'running', 'accepted', 'pending'].includes(row.status)
    ? 'operation_queued'
    : row.status === 'completed'
      ? 'operation_completed'
      : ['pending_review', 'needs_human_approval'].includes(row.status)
        ? 'needs_human_approval'
        : 'operation_failed';
  output = {
    status,
    operation: request.operation,
    provider: request.provider,
    actionLogId: request.action_log_id,
    vaultItemId: request.credential_id,
    message: row.error || `Weles credential operation is ${row.status}`,
  };
}
process.stdout.write(`${JSON.stringify(output)}\n`);
