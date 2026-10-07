// Meta Marketing API objects, reached through wisent-integrations
// (`echo-paid-ads/meta.graph.*`): the access token and the Graph version stay
// in the integrations service's `meta-ads-api` item, and a journey names only
// an object id, or an owner id and one edge.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { integrationAction } from '../../../../_shared/integrations.mjs';

export function adAccountId() {
  const raw =
    process.env.AD_ACCOUNT_ID || process.env.META_ADS_COMPANY_ACCOUNT_ID;
  if (!raw)
    throw new Error('AD_ACCOUNT_ID or META_ADS_COMPANY_ACCOUNT_ID required');
  return raw.startsWith('act_') ? raw : `act_${raw.replace(/\D/g, '')}`;
}

export function submitEnabled() {
  return process.env.SUBMIT === '1';
}

export function boolEnv(name, fallback = false) {
  if (process.env[name] == null) return fallback;
  return /^(1|true|yes)$/i.test(process.env[name] || '');
}

export function numberEnv(name) {
  if (process.env[name] == null || process.env[name] === '') return undefined;
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) throw new Error(`${name} must be numeric`);
  return n;
}

export function microsFromUsd(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`invalid USD amount: ${value}`);
  // Meta Marketing API monetary fields use the account currency's minor unit
  // for USD ad accounts, not micro-units.
  return Math.round(n * 100);
}

export function splitList(value, sep = ',') {
  return String(value || '')
    .split(sep)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function parseJsonEnv(name, fallback = undefined) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${name} must be valid JSON: ${e.message}`);
  }
}

export function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => {
      if (v === undefined || v === null || v === '') return false;
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        Object.keys(v).length === 0
      )
        return false;
      return true;
    }),
  );
}

/** Graph parameters without the unset ones; the service sends each as Meta reads it. */
function graphParams(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
  );
}

export function withValidateOnly(
  params,
  { submit = submitEnabled(), validateOnly = true } = {},
) {
  if (submit || !validateOnly) return params;
  return { ...params, execution_options: ['validate_only'] };
}

function requestEnabled(opts = {}) {
  if (opts.submit != null) return Boolean(opts.submit);
  if (opts.execute != null) return Boolean(opts.execute);
  return submitEnabled();
}

/** `/id` or `/owner/edge`, as the journeys write their Graph paths. */
function graphTarget(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 1) return { id: parts[0] };
  if (parts.length === 2) return { owner_id: parts[0], edge: parts[1] };
  throw new Error(
    `Meta Graph path ${path} is neither /<id> nor /<owner>/<edge>`,
  );
}

function graphAction(method, target) {
  if (target.id) {
    if (method === 'GET') return 'meta.graph.read';
    if (method === 'POST') return 'meta.graph.update';
    if (method === 'DELETE') return 'meta.graph.delete';
  } else {
    if (method === 'GET') return 'meta.graph.list';
    if (method === 'POST') return 'meta.graph.create';
  }
  throw new Error(
    `Meta Graph ${method} is not an action on ${JSON.stringify(target)}`,
  );
}

export async function graphRequest(method, path, params = {}, opts = {}) {
  if (!requestEnabled(opts))
    throw new Error('SUBMIT=1 required for Meta Marketing API request');
  const target = graphTarget(path);
  const json = await integrationAction(
    'echo-paid-ads',
    graphAction(method, target),
    { ...target, params: graphParams(params) },
  );
  console.log(JSON.stringify(json, null, 2));
  return json;
}

export async function graphUpload(
  path,
  fields,
  _fileField,
  filePath,
  opts = {},
) {
  if (!requestEnabled(opts))
    throw new Error('SUBMIT=1 required for Meta Marketing API upload');
  const target = graphTarget(path);
  if (!target.edge)
    throw new Error(`Meta Graph upload path ${path} names no edge`);
  const json = await integrationAction('echo-paid-ads', 'meta.graph.upload', {
    ...target,
    params: graphParams(fields),
    filename: basename(filePath),
    content_base64: readFileSync(filePath).toString('base64'),
  });
  console.log(JSON.stringify(json, null, 2));
  return json;
}
