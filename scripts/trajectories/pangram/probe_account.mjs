// Read-only diagnostic for Pangram social account availability in Weles.
// Prints no secrets and never opens a browser.

import { getSocialAccount } from '../../../dist/utils/credentials.js';

async function serviceCredentialProbe() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return { available: false, reason: 'missing_supabase_env' };
  const url = `${supabaseUrl}/rest/v1/service_credentials?display_name=ilike.*pangram*&select=display_name,login_email,login_password,login_method`;
  const res = await fetch(url, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } });
  if (!res.ok) return { available: false, reason: `fetch_failed_${res.status}` };
  const rows = await res.json();
  return {
    available: rows.length > 0,
    rows: rows.map((r) => ({
      display_name: r.display_name,
      has_login_email: Boolean(r.login_email),
      has_login_password: Boolean(r.login_password),
      login_method: r.login_method ?? null,
    })),
  };
}

const acct = await getSocialAccount('pangram');
if (!acct) {
  console.log(JSON.stringify({ platform: 'pangram', account: null, reason: 'no active account or missing Supabase env', service_credentials: await serviceCredentialProbe() }, null, 2));
  process.exit(1);
}

const metadata = acct.metadata || {};
const cookies = Array.isArray(metadata.cookies) ? metadata.cookies : [];
const domains = [...new Set(cookies.map((c) => c?.domain).filter(Boolean))].sort();

console.log(JSON.stringify({
  platform: 'pangram',
  account: {
    id: acct.id,
    username: acct.username ?? null,
    cookie_count: cookies.length,
    cookie_domains: domains,
    cookies_minted_at: metadata.cookies_minted_at ?? null,
    cookies_stale_at: metadata.cookies_stale_at ?? null,
    has_persona: Boolean(metadata.persona),
    has_proxy: Boolean(metadata.proxy || metadata.proxy_url || metadata.proxyUrl),
  },
  service_credentials: await serviceCredentialProbe(),
}, null, 2));
