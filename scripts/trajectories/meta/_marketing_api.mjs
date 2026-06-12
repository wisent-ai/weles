import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export function apiVersion() {
  return process.env.META_GRAPH_API_VERSION || process.env.META_MARKETING_API_VERSION || 'v25.0';
}

export function graphBase() {
  return `https://graph.facebook.com/${apiVersion()}`;
}

export function accessToken({ required = true } = {}) {
  const token = process.env.META_ACCESS_TOKEN || process.env.FACEBOOK_ACCESS_TOKEN || process.env.META_SYSTEM_USER_ACCESS_TOKEN;
  if (!token && required) throw new Error('META_ACCESS_TOKEN required for SUBMIT=1 or live read');
  return token || '';
}

export function adAccountId() {
  const raw = process.env.AD_ACCOUNT_ID || process.env.META_ADS_COMPANY_ACCOUNT_ID;
  if (!raw) throw new Error('AD_ACCOUNT_ID or META_ADS_COMPANY_ACCOUNT_ID required');
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
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid USD amount: ${value}`);
  // Meta Marketing API monetary fields use the account currency's minor unit
  // for USD ad accounts, not micro-units.
  return Math.round(n * 100);
}

export function splitList(value, sep = ',') {
  return String(value || '').split(sep).map((v) => v.trim()).filter(Boolean);
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
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => {
    if (v === undefined || v === null || v === '') return false;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return false;
    return true;
  }));
}

export function stringifyGraphValue(v) {
  if (Array.isArray(v) || (v && typeof v === 'object')) return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function withValidateOnly(params, { submit = submitEnabled(), validateOnly = true } = {}) {
  if (submit || !validateOnly) return params;
  return { ...params, execution_options: ['validate_only'] };
}

export function printDryRun(label, request) {
  const redacted = JSON.parse(JSON.stringify(request));
  if (redacted.params?.access_token) redacted.params.access_token = '[redacted]';
  if (redacted.body?.access_token) redacted.body.access_token = '[redacted]';
  console.log(`[${label}] SUBMIT=0 dry run`);
  console.log(JSON.stringify(redacted, null, 2).slice(0, 20000));
}

export async function graphRequest(method, path, params = {}, opts = {}) {
  const submit = opts.submit ?? submitEnabled();
  const dryRun = opts.dryRun ?? !submit;
  const label = opts.label || 'meta-marketing-api';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const request = { method, url: `${graphBase()}${normalizedPath}`, params };
  if (dryRun) {
    printDryRun(label, request);
    return { dryRun: true, request };
  }

  const token = accessToken();
  const url = new URL(request.url);
  const headers = {};
  const fetchOpts = { method, headers };
  const bodyParams = { ...params, access_token: token };

  if (method === 'GET' || method === 'DELETE') {
    for (const [k, v] of Object.entries(bodyParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, stringifyGraphValue(v));
    }
  } else {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(bodyParams)) {
      if (v !== undefined && v !== null) form.set(k, stringifyGraphValue(v));
    }
    fetchOpts.body = form;
  }

  const res = await fetch(url, fetchOpts);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Meta Marketing API ${res.status}: ${text.slice(0, 1600)}`);
    err.response = json;
    throw err;
  }
  console.log(JSON.stringify(json, null, 2).slice(0, 20000));
  return json;
}

export async function graphUpload(path, fields, fileField, filePath, opts = {}) {
  const submit = opts.submit ?? submitEnabled();
  const dryRun = opts.dryRun ?? !submit;
  const label = opts.label || 'meta-marketing-api-upload';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const request = { method: 'POST', url: `${graphBase()}${normalizedPath}`, fields, fileField, filePath };
  if (dryRun) {
    printDryRun(label, request);
    return { dryRun: true, request };
  }

  const form = new FormData();
  for (const [k, v] of Object.entries({ ...fields, access_token: accessToken() })) {
    if (v !== undefined && v !== null) form.set(k, stringifyGraphValue(v));
  }
  const bytes = readFileSync(filePath);
  form.set(fileField, new Blob([bytes]), basename(filePath));
  const res = await fetch(`${graphBase()}${normalizedPath}`, { method: 'POST', body: form });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Meta Marketing API upload ${res.status}: ${text.slice(0, 1600)}`);
  console.log(JSON.stringify(json, null, 2).slice(0, 20000));
  return json;
}
