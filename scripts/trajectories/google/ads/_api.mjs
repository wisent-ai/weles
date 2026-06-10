import { spawnSync } from 'node:child_process';

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

export function accessToken() {
  if (process.env.GOOGLE_ADS_ACCESS_TOKEN) return process.env.GOOGLE_ADS_ACCESS_TOKEN;
  const r = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new Error('GOOGLE_ADS_ACCESS_TOKEN required, or install/auth gcloud so `gcloud auth print-access-token` works');
}

export function headers() {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN required');
  const h = {
    Authorization: `Bearer ${accessToken()}`,
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
  const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
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
