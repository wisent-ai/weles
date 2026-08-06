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

async function waitForAction(actionLogId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionLogId)) {
    throw new Error('invalid Weles action id');
  }
  const baseURL = (process.env.WELES_DATABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.WELES_DATABASE_TOKEN || '';
  if (!baseURL || !serviceKey) throw new Error('Weles status service is unavailable');
  const deadline = Date.now() + 20 * 60 * 1000;
  const terminalFailures = new Set(['failed', 'cancelled', 'pending_review', 'needs_human_approval']);
  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseURL}/rest/v1/account_action_logs?id=eq.${encodeURIComponent(actionLogId)}&select=id,status`,
      {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error('Weles status request failed');
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) throw new Error('Weles action was not found');
    if (row.status === 'completed') {
      return {
        status: 'completed',
        actionLogId,
        message: 'Credential encrypted in Skarbiec and synchronized.',
      };
    }
    if (terminalFailures.has(row.status)) {
      return {
        status: row.status,
        actionLogId,
        message: row.status === 'needs_human_approval' || row.status === 'pending_review'
          ? 'Weles requires human review before the credential can be stored.'
          : 'Weles could not complete the credential request.',
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  return {
    status: 'timed_out',
    actionLogId,
    message: 'Weles did not finish the credential request within 20 minutes.',
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
  dryRun: Boolean(stdinRequest.dryRun) || boolArg('dry-run') || process.env.WELES_SECRET_DRY_RUN === '1',
  autoPromoteTrajectory: stdinRequest.autoPromoteTrajectory !== false && !boolArg('no-auto-promote'),
  proxy: stdinRequest.proxy || arg('proxy') || undefined,
  headless: Boolean(stdinRequest.headless) || boolArg('headless'),
  priority: stdinRequest.priority ?? numberArg('priority'),
  tenantId: stdinRequest.tenantId || arg('tenant-id') || undefined,
};

const result = await acquireSecret(request);
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'unsupported_secret' || result.status === 'needs_configuration' ? 2 : 0);
