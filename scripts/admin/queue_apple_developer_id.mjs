#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { enqueueWelesAction } from '../_shared/stado-action-queue.mjs';
import { activeSkarbiecBinary } from '../_shared/skarbiec-runtime.mjs';

const accountItem = process.env.APPLE_ACCOUNT_ITEM ?? '';
const csrPath = process.env.APPLE_CSR_PATH ?? '';
const certificatePath = process.env.APPLE_CERTIFICATE_PATH ?? '';
const executionHost = process.env.APPLE_EXECUTION_HOST ?? '';
const executionAgent = process.env.APPLE_EXECUTION_AGENT ?? 'weles-worker';
if (!/^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$/.test(accountItem)) throw new Error('APPLE_ACCOUNT_ITEM must name an Apple Skarbiec account item');
for (const [name, value] of [['APPLE_CSR_PATH', csrPath], ['APPLE_CERTIFICATE_PATH', certificatePath], ['APPLE_EXECUTION_HOST', executionHost]]) {
  if (!value) throw new Error(`${name} is required`);
}
const guardId = randomUUID();
const skarbiec = activeSkarbiecBinary();
const issued = [];
function capability(purpose, resource) {
  const result = spawnSync(skarbiec, ['capability-issue', '--agent', executionAgent, '--purpose', purpose, '--resource', resource, '--target', 'weles', '--ttl', '3600', '--max-uses', '1', '--authorization-id', guardId], { encoding: 'utf8', env: process.env });
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
    action: 'apple_create_developer_id', accountItem,
    params: {
      apple_auth_guard_id: guardId, apple_execution_host: executionHost,
      apple_execution_agent: executionAgent, apple_csr_path: csrPath,
      apple_certificate_path: certificatePath,
      apple_login_capabilities: { email, password, two_factor: { mode: 'capability', capability: twoFactor } },
    }, priority: 1000, pinnedHost: executionHost,
  });
  console.log(JSON.stringify({ status: 'queued', guard_id: guardId, job_id: jobId, account_item: accountItem }));
} catch (error) {
  for (const capabilityId of issued) spawnSync(skarbiec, ['capability-cancel', '--agent', executionAgent, '--capability-id', capabilityId, '--authorization-id', guardId]);
  throw error;
}
