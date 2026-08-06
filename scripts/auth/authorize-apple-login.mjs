#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const CONFIRMATION_PHRASE = 'AUTHORIZE ONE APPLE LOGIN';
const DEFAULT_EXPIRY_MINUTES = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_ID_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,252}[A-Za-z0-9])?$/;
const SAFE_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const SAFE_EXECUTION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;
const SAFE_REMOTE_PATH_PATTERN = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const SSH_TIMEOUT_MS = 20_000;
const ALLOWED_FLAGS = new Set([
  '--account-id', '--approver', '--reason', '--confirm', '--expires-in-minutes',
  '--execution-host', '--execution-agent',
  '--ssh-host', '--ssh-user', '--ssh-port', '--ssh-identity-file', '--ssh-known-hosts-file',
  '--remote-skarbiec-command',
]);

function usage() {
  console.error(
    'Usage: node scripts/auth/authorize-apple-login.mjs '
    + '--account-id <uuid> --approver <identity> --reason <reason> '
    + '--execution-host <exact-os-hostname> --execution-agent <worker-agent-id> '
    + '--ssh-host <host> --ssh-user <user> --ssh-port <port> '
    + '--ssh-identity-file <absolute-path> --ssh-known-hosts-file <absolute-path> '
    + '--remote-skarbiec-command <absolute-path> '
    + `--confirm "${CONFIRMATION_PHRASE}" [--expires-in-minutes ${DEFAULT_EXPIRY_MINUTES}]`,
  );
}

function parseFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!ALLOWED_FLAGS.has(name) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid or incomplete flag: ${name ?? '(missing)'}`);
    }
    if (flags.has(name)) throw new Error(`Duplicate flag: ${name}`);
    flags.set(name, value);
  }
  return flags;
}

function requireRegularFile(path, name, ownerOnly) {
  if (/[\u0000\r\n]/.test(path)) throw new Error(`${name} contains forbidden control characters`);
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${name} must name a regular file`);
  if (ownerOnly && (stat.mode & 0o077) !== 0) throw new Error(`${name} must be owner-only`);
  if (ownerOnly && typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${name} owner mismatch`);
  return path;
}

function remoteConfiguration(flags) {
  const host = flags.get('--ssh-host') ?? '';
  const user = flags.get('--ssh-user') ?? '';
  const portText = flags.get('--ssh-port') ?? '';
  const identityFile = flags.get('--ssh-identity-file') ?? '';
  const knownHostsFile = flags.get('--ssh-known-hosts-file') ?? '';
  const skarbiecCommand = flags.get('--remote-skarbiec-command') ?? '';
  if (!SAFE_HOST_PATTERN.test(host) || host.startsWith('-') || host.includes('..')) throw new Error('--ssh-host is invalid');
  if (!SAFE_USER_PATTERN.test(user)) throw new Error('--ssh-user is invalid');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--ssh-port must be an integer from 1 to 65535');
  requireRegularFile(identityFile, '--ssh-identity-file', true);
  requireRegularFile(knownHostsFile, '--ssh-known-hosts-file', true);
  if (!SAFE_REMOTE_PATH_PATTERN.test(skarbiecCommand) || skarbiecCommand.split('/').includes('..')) {
    throw new Error('--remote-skarbiec-command must be a safe absolute path');
  }
  return { host, user, port, identityFile, knownHostsFile, skarbiecCommand };
}

function runRemoteJson(config, remoteArguments) {
  const result = spawnSync('ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.knownHostsFile}`, '-o', 'LogLevel=ERROR',
    '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=10', '-i', config.identityFile,
    '-p', String(config.port), '--', `${config.user}@${config.host}`,
    config.skarbiecCommand, ...remoteArguments,
  ], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: SSH_TIMEOUT_MS,
    maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error('Remote Skarbiec command failed closed');
  try { return JSON.parse(result.stdout); } catch { throw new Error('Remote Skarbiec command returned invalid JSON'); }
}

function issueCapability(config, agent, purpose, resource, authorizationId, expiresAtMs) {
  const ttlSeconds = Math.floor((expiresAtMs - Date.now()) / 1000);
  if (ttlSeconds < 1 || ttlSeconds > 3600) throw new Error('Guard expiry cannot safely bound capability TTL');
  const payload = runRemoteJson(config, [
    'capability-issue', '--agent', agent, '--purpose', purpose, '--resource', resource,
    '--target', 'weles', '--ttl', String(ttlSeconds), '--max-uses', '1',
    '--authorization-id', authorizationId,
  ]);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).sort().join(',') !== 'capability_id,status'
    || payload.status !== 'issued' || typeof payload.capability_id !== 'string'
    || !CAPABILITY_ID_PATTERN.test(payload.capability_id)) {
    throw new Error('Remote Skarbiec returned an invalid capability identifier');
  }
  return { capability_id: payload.capability_id, purpose, resource, target: 'weles', authorization_id: authorizationId };
}

function cancelCapability(config, agent, capabilityId, authorizationId) {
  const payload = runRemoteJson(config, [
    'capability-cancel', '--agent', agent, '--capability-id', capabilityId,
    '--authorization-id', authorizationId,
  ]);
  if (!payload || payload.status !== 'cancelled') throw new Error('Remote capability cancellation was not acknowledged');
}

async function rpc(configuredUrl, databaseToken, name, body) {
  const response = await fetch(`${configuredUrl.replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: databaseToken, Authorization: `Bearer ${databaseToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${name} failed closed (HTTP ${response.status})`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`${name} returned invalid JSON`); }
  if (!Array.isArray(payload) || payload.length !== 1 || !UUID_PATTERN.test(payload[0]?.id ?? '')) {
    throw new Error(`${name} returned no unique guard row`);
  }
  return payload[0];
}

function apiHeaders(databaseToken, prefer) {
  return {
    apikey: databaseToken,
    Authorization: `Bearer ${databaseToken}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function createPendingAction(configuredUrl, databaseToken, accountId, params) {
  const response = await fetch(`${configuredUrl.replace(/\/+$/, '')}/rest/v1/account_action_logs`, {
    method: 'POST',
    headers: apiHeaders(databaseToken, 'return=representation'),
    body: JSON.stringify({
      account_id: accountId,
      platform: 'apple',
      action: 'apple_login',
      status: 'pending_review',
      scheduled_at: new Date().toISOString(),
      params,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Apple login action creation failed closed (HTTP ${response.status})`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Apple login action creation returned invalid JSON'); }
  const row = Array.isArray(payload) && payload.length === 1 ? payload[0] : null;
  if (!row || !UUID_PATTERN.test(row.id ?? '') || row.account_id !== accountId
      || row.action !== 'apple_login' || row.status !== 'pending_review') {
    throw new Error('Apple login action creation returned a mismatched row');
  }
  return row.id;
}

async function patchAction(configuredUrl, databaseToken, actionLogId, body) {
  const response = await fetch(
    `${configuredUrl.replace(/\/+$/, '')}/rest/v1/account_action_logs?id=eq.${encodeURIComponent(actionLogId)}`,
    {
      method: 'PATCH',
      headers: apiHeaders(databaseToken, 'return=minimal'),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`Apple login action update failed closed (HTTP ${response.status})`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const accountId = (flags.get('--account-id') ?? '').toLowerCase();
  const approver = (flags.get('--approver') ?? '').trim();
  const reason = (flags.get('--reason') ?? '').trim();
  const confirmation = flags.get('--confirm') ?? '';
  const executionHost = flags.get('--execution-host') ?? '';
  const executionAgent = flags.get('--execution-agent') ?? '';
  const expiryText = flags.get('--expires-in-minutes') ?? String(DEFAULT_EXPIRY_MINUTES);
  const remote = remoteConfiguration(flags);

  if (!UUID_PATTERN.test(accountId)) throw new Error('--account-id must be a valid UUID');
  if (!approver || approver.length > 200) throw new Error('--approver must contain 1 to 200 characters');
  if (!reason || reason.length > 1000) throw new Error('--reason must contain 1 to 1000 characters');
  if (!SAFE_EXECUTION_PATTERN.test(executionHost) || executionHost.length > 253) {
    throw new Error('--execution-host is invalid');
  }
  if (!SAFE_EXECUTION_PATTERN.test(executionAgent) || executionAgent.length > 200) {
    throw new Error('--execution-agent is invalid');
  }
  if (confirmation !== CONFIRMATION_PHRASE) throw new Error(`--confirm must exactly equal "${CONFIRMATION_PHRASE}"`);
  const expiryMinutes = Number(expiryText);
  if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 60) {
    throw new Error('--expires-in-minutes must be an integer from 1 to 60');
  }

  const configuredUrl = process.env.WELES_DATABASE_URL ?? '';
  const databaseToken = process.env.WELES_DATABASE_TOKEN ?? '';
  if (!configuredUrl.trim() || !databaseToken.trim()) throw new Error('WELES_DATABASE_URL and WELES_DATABASE_TOKEN are required');
  let parsedUrl;
  try { parsedUrl = new URL(configuredUrl); } catch { throw new Error('WELES_DATABASE_URL is invalid'); }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') throw new Error('WELES_DATABASE_URL must use HTTP or HTTPS');

  const expiresAt = new Date(Date.now() + expiryMinutes * 60_000).toISOString();
  const guard = await rpc(configuredUrl, databaseToken, 'authorize_apple_auth_submit_guard', {
    p_account_id: accountId,
    p_created_by: approver,
    p_reason: reason,
    p_expires_at: expiresAt,
    p_execution_host: executionHost,
    p_execution_agent: executionAgent,
  });
  if (guard.account_id !== accountId || Date.parse(guard.expires_at) !== Date.parse(expiresAt)
      || guard.execution_host !== executionHost || guard.execution_agent !== executionAgent
      || guard.state !== 'authorized' || guard.attempt_count !== 0) {
    throw new Error('Authorization RPC returned a mismatched guard');
  }

  const guardId = guard.id;
  const guardExpiresAtMs = Date.parse(expiresAt);
  const issued = [];
  let actionLogId = null;
  try {
    const email = issueCapability(remote, executionAgent, 'weles.browser.fill', 'origin:https://idmsa.apple.com/email', guardId, guardExpiresAtMs);
    issued.push(email.capability_id);
    const password = issueCapability(remote, executionAgent, 'weles.browser.fill', 'origin:https://idmsa.apple.com/password', guardId, guardExpiresAtMs);
    issued.push(password.capability_id);
    const twoFactorCapability = issueCapability(remote, executionAgent, 'weles.apple.2fa', `challenge:apple/${guardId}`, guardId, guardExpiresAtMs);
    issued.push(twoFactorCapability.capability_id);
    if (new Set(issued).size !== 3) throw new Error('Remote Skarbiec returned duplicate capability identifiers');

    const queueParams = {
      apple_auth_guard_id: guardId,
      apple_execution_host: executionHost,
      apple_execution_agent: executionAgent,
    };
    actionLogId = await createPendingAction(configuredUrl, databaseToken, accountId, queueParams);
    const bound = await rpc(configuredUrl, databaseToken, 'bind_apple_auth_submit_guard', {
      p_guard_id: guardId,
      p_account_id: accountId,
      p_action_log_id: actionLogId,
    });
    if (bound.action_log_id !== actionLogId || bound.state !== 'authorized' || bound.attempt_count !== 0) {
      throw new Error('Apple authorization binding returned a mismatched guard');
    }
    const stored = await rpc(configuredUrl, databaseToken, 'store_apple_auth_capability_envelope', {
      p_guard_id: guardId,
      p_account_id: accountId,
      p_action_log_id: actionLogId,
      p_email_capability_id: email.capability_id,
      p_password_capability_id: password.capability_id,
      p_two_factor_capability_id: twoFactorCapability.capability_id,
    });
    if (stored.action_log_id !== actionLogId || stored.state !== 'authorized') {
      throw new Error('Apple capability envelope storage returned a mismatched guard');
    }
    await patchAction(configuredUrl, databaseToken, actionLogId, {
      status: 'queued',
      scheduled_at: new Date().toISOString(),
    });
    console.log(JSON.stringify({
      status: 'queued',
      guard_id: guardId,
      action_log_id: actionLogId,
      account_id: accountId,
      expires_at: expiresAt,
      execution_host: executionHost,
      execution_agent: executionAgent,
    }));
  } catch (error) {
    const cleanupErrors = [];
    if (actionLogId) {
      try {
        await patchAction(configuredUrl, databaseToken, actionLogId, {
          status: 'failed',
          error: 'Owner-authorized Apple login setup failed before execution',
          completed_at: new Date().toISOString(),
        });
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    const capabilityCleanupErrors = [];
    for (const capabilityId of issued.reverse()) {
      try { cancelCapability(remote, executionAgent, capabilityId, guardId); } catch (cleanupError) { capabilityCleanupErrors.push(cleanupError); }
    }
    cleanupErrors.push(...capabilityCleanupErrors);
    if (capabilityCleanupErrors.length === 0) {
      try {
        await rpc(configuredUrl, databaseToken, 'cancel_apple_auth_submit_guard', {
          p_guard_id: guardId,
          p_reason: 'Authorization setup failed before execution; issued capabilities cancelled',
        });
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'Apple login authorization failed and cleanup was not fully confirmed');
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Apple login authorization failed closed');
  usage();
  process.exitCode = 1;
});
