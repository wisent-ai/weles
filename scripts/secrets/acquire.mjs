import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { acquireSecret } from '../../dist/secrets/acquire.js';

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

function boolArg(name) {
  const raw = arg(name);
  if (!raw) return process.argv.includes(`--${name}`);
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

function numberArg(name) {
  const raw = arg(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function waitForAction(jobId) {
  if (!/^[0-9a-f]{8}$/i.test(jobId)) throw new Error('invalid Stado job id');
  const stado = process.env.WELES_STADO_BIN || join(homedir(), '.stado', 'bin', 'stado');
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const output = execFileSync(stado, ['status', jobId], { encoding: 'utf8' });
    const normalized = output.toLowerCase();
    if (/\b(completed|succeeded|success)\b/.test(normalized)) {
      return { status: 'completed', jobId, message: 'Credential encrypted in Skarbiec and synchronized.' };
    }
    const failure = normalized.match(/\b(failed|cancelled|canceled|pending_review|needs_human_approval)\b/)?.[1];
    if (failure) {
      return {
        status: failure,
        jobId,
        message: failure === 'needs_human_approval' || failure === 'pending_review'
          ? 'Weles requires human review before the credential can be stored.'
          : 'Weles could not complete the credential request.',
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  return {
    status: 'timed_out',
    jobId,
    message: 'Stado did not finish the credential request within 20 minutes.',
  };
}

const waitActionLogId = arg('wait-action');
if (waitActionLogId) {
  const status = await waitForAction(waitActionLogId);
  console.log(JSON.stringify(status));
  process.exit(0);
}

let stdinRequest = {};
if (process.argv.includes('--stdin-json')) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 65_536) throw new Error('credential request JSON exceeds 65536 bytes');
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('credential request JSON must be an object');
  }
  stdinRequest = parsed;
}

const request = {
  goal: stdinRequest.goal || arg('goal') || process.env.WELES_SECRET_GOAL || undefined,
  secret: stdinRequest.secret || arg('secret') || process.env.WELES_SECRET || undefined,
  purpose: stdinRequest.purpose || arg('purpose') || process.env.WELES_SECRET_PURPOSE || undefined,
  accountEmail: stdinRequest.accountEmail || arg('account-email') || undefined,
  skarbiecRequestId: stdinRequest.skarbiecRequestId || arg('skarbiec-request-id') || undefined,
  skarbiecCredentialId: stdinRequest.skarbiecCredentialId || arg('skarbiec-credential-id') || undefined,
  dryRun: Boolean(stdinRequest.dryRun) || boolArg('dry-run') || process.env.WELES_SECRET_DRY_RUN === '1',
  autoPromoteTrajectory: stdinRequest.autoPromoteTrajectory !== false && !boolArg('no-auto-promote'),
  proxy: stdinRequest.proxy || arg('proxy') || undefined,
  headless: Boolean(stdinRequest.headless) || boolArg('headless'),
  priority: stdinRequest.priority ?? numberArg('priority'),
  tenantId: stdinRequest.tenantId || arg('tenant-id') || undefined,
};

const result = await acquireSecret(request);
console.log(JSON.stringify({
  ...result,
  ...(request.skarbiecCredentialId ? { vaultItemId: request.skarbiecCredentialId } : {}),
}, null, 2));
process.exit(result.status === 'unsupported_secret' || result.status === 'needs_configuration' ? 2 : 0);
