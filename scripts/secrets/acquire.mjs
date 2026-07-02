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

const request = {
  goal: arg('goal') || process.env.WELES_SECRET_GOAL || undefined,
  secret: arg('secret') || process.env.WELES_SECRET || undefined,
  purpose: arg('purpose') || process.env.WELES_SECRET_PURPOSE || undefined,
  dryRun: boolArg('dry-run') || process.env.WELES_SECRET_DRY_RUN === '1',
  autoPromoteTrajectory: !boolArg('no-auto-promote'),
  proxy: arg('proxy') || undefined,
  headless: boolArg('headless'),
  priority: numberArg('priority'),
  tenantId: arg('tenant-id') || undefined,
};

const result = await acquireSecret(request);
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'unsupported_secret' || result.status === 'needs_configuration' ? 2 : 0);
