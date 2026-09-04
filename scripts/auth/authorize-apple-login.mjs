#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { enqueueWelesAction } from '../_shared/stado-action-queue.mjs';
import { issueAppleLoginCapabilities } from './apple-account-placement.mjs';

const CONFIRMATION_PHRASE = 'AUTHORIZE ONE APPLE LOGIN';
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) pairs.push([value, all[index + 1]]);
  return pairs;
}, []));
const accountItem = String(args['--account-item'] ?? '');
const confirmation = String(args['--confirm'] ?? '');
const executionHost = String(args['--execution-host'] ?? '');
const executionAgent = String(args['--execution-agent'] ?? 'weles-worker');
const expiryMinutes = Number(args['--expires-in-minutes'] ?? '10');
if (!/^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$/.test(accountItem)) throw new Error('--account-item must name an Apple Skarbiec account item');
if (confirmation !== CONFIRMATION_PHRASE) throw new Error(`--confirm must exactly equal "${CONFIRMATION_PHRASE}"`);
if (!executionHost || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(executionHost)) throw new Error('--execution-host is invalid');
if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 60) throw new Error('--expires-in-minutes must be 1..60');

const guardId = randomUUID();
let capabilities = null;
try {
  capabilities = issueAppleLoginCapabilities({
    executionHost,
    executionAgent,
    authorizationId: guardId,
    ttlSeconds: expiryMinutes * 60,
  });
  const jobId = enqueueWelesAction({
    action: 'apple_login',
    accountItem,
    params: {
      apple_auth_guard_id: guardId,
      apple_execution_host: executionHost,
      apple_execution_agent: executionAgent,
      apple_login_capabilities: capabilities,
    },
    pinnedHost: executionHost,
  });
  console.log(JSON.stringify({
    status: 'queued',
    guard_id: guardId,
    job_id: jobId,
    account_item: accountItem,
    execution_host: executionHost,
  }));
} catch (error) {
  if (capabilities) {
    console.error(JSON.stringify({
      status: 'failed',
      guard_id: guardId,
      execution_host: executionHost,
      outstanding_capabilities: 3,
      bound_by: `ttl ${expiryMinutes * 60}s, max-uses 1 each`,
      note: 'nothing was enqueued; each capability expires on the execution host',
    }));
  }
  throw error;
}
