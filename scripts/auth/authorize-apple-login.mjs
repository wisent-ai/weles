#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { enqueueWelesAction } from '../_shared/stado-action-queue.mjs';
import { activeSkarbiecBinary } from '../_shared/skarbiec-runtime.mjs';

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
const skarbiec = activeSkarbiecBinary();
const issued = [];
function capability(purpose, resource) {
  const result = spawnSync(skarbiec, [
    'capability-issue', '--agent', executionAgent, '--purpose', purpose,
    '--resource', resource, '--target', 'weles', '--ttl', String(expiryMinutes * 60),
    '--max-uses', '1', '--authorization-id', guardId,
  ], { encoding: 'utf8', env: process.env });
  if (result.error || result.status !== 0) throw new Error(`Skarbiec refused Apple capability: ${(result.stderr || result.error?.message || '').trim()}`);
  const payload = JSON.parse(result.stdout);
  if (!/^[0-9a-f]{64}$/.test(String(payload.capability_id ?? ''))) throw new Error('Skarbiec returned an invalid capability id');
  issued.push(payload.capability_id);
  return { capability_id: payload.capability_id, purpose, resource, target: 'weles', authorization_id: guardId };
}
try {
  const email = capability('weles.browser.fill', 'origin:https://idmsa.apple.com/email');
  const password = capability('weles.browser.fill', 'origin:https://idmsa.apple.com/password');
  const twoFactor = capability('weles.apple.2fa', `challenge:apple/${guardId}`);
  const jobId = enqueueWelesAction({
    action: 'apple_login', accountItem,
    params: {
      apple_auth_guard_id: guardId,
      apple_execution_host: executionHost,
      apple_execution_agent: executionAgent,
      apple_login_capabilities: { email, password, two_factor: { mode: 'capability', capability: twoFactor } },
    },
    pinnedHost: executionHost,
  });
  console.log(JSON.stringify({ status: 'queued', guard_id: guardId, job_id: jobId, account_item: accountItem }));
} catch (error) {
  // `capability-cancel` is not a Skarbiec command and never was, so this loop
  // spawned an unknown binary and dropped the failure: the rollback has never
  // withdrawn anything. What actually bounds an issued capability is the TTL and
  // max-uses it carries, so report what is outstanding rather than claim a
  // withdrawal that did not happen.
  if (issued.length) {
    console.error(JSON.stringify({
      status: 'failed', guard_id: guardId, outstanding_capabilities: issued.length,
      bound_by: `ttl ${expiryMinutes * 60}s, max-uses 1 each`,
      note: 'nothing was enqueued; each capability expires on its own',
    }));
  }
  throw error;
}
