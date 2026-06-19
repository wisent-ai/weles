import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function customerId() {
  const id = process.env.GOOGLE_ADS_CUSTOMER_ID;
  if (!id) throw new Error('GOOGLE_ADS_CUSTOMER_ID required');
  return id.replace(/\D/g, '');
}

export function apiVersion() {
  return process.env.GOOGLE_ADS_API_VERSION || 'v24';
}

export function microsFromUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid USD amount: ${value}`);
  return Math.round(n * 1_000_000);
}

function oauthClientFromFile(path) {
  if (!path || !existsSync(path)) return null;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const root = json.installed || json.web || json;
  if (!root.client_id || !root.client_secret) return null;
  return { clientId: root.client_id, clientSecret: root.client_secret };
}

function oauthClient() {
  if (process.env.GOOGLE_ADS_CLIENT_ID && process.env.GOOGLE_ADS_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_ADS_CLIENT_ID, clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET };
  }
  return oauthClientFromFile(process.env.GOOGLE_ADS_OAUTH_CLIENT_FILE)
    || oauthClientFromFile(join(homedir(), 'Downloads', 'credentials.json'));
}

async function refreshAccessToken() {
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  if (!refreshToken) return null;
  const client = oauthClient();
  if (!client) {
    throw new Error('GOOGLE_ADS_REFRESH_TOKEN is set, but GOOGLE_ADS_CLIENT_ID/GOOGLE_ADS_CLIENT_SECRET or GOOGLE_ADS_OAUTH_CLIENT_FILE is missing');
  }
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || !json.access_token) {
    throw new Error(`Google OAuth refresh failed ${res.status}: ${text.slice(0, 500)}`);
  }
  return json.access_token;
}

export async function accessToken() {
  if (process.env.GOOGLE_ADS_ACCESS_TOKEN) return process.env.GOOGLE_ADS_ACCESS_TOKEN;
  const refreshed = await refreshAccessToken();
  if (refreshed) return refreshed;
  const r = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new Error('GOOGLE_ADS_ACCESS_TOKEN or GOOGLE_ADS_REFRESH_TOKEN required, or install/auth gcloud so `gcloud auth print-access-token` works');
}

export async function headers() {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN required');
  const h = {
    Authorization: `Bearer ${await accessToken()}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  if (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    h['login-customer-id'] = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/\D/g, '');
  }
  return h;
}

export async function googleAdsPost(path, body) {
  const url = `https://googleads.googleapis.com/${apiVersion()}${path}`;
  const res = await fetch(url, { method: 'POST', headers: await headers(), body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Google Ads API ${res.status}: ${text.slice(0, 1000)}`);
    err.response = json;
    throw err;
  }
  return json;
}

export async function googleAdsMutate(customerIdValue, mutateOperations, opts = {}) {
  return googleAdsPost(`/customers/${customerIdValue}/googleAds:mutate`, {
    mutateOperations,
    partialFailure: opts.partialFailure === true,
    validateOnly: opts.validateOnly === true,
    responseContentType: opts.responseContentType || 'MUTABLE_RESOURCE',
  });
}
