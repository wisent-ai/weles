// Read-only diagnostic for Pangram social account availability in Weles.
// Prints no secrets and never opens a browser.

import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { listServiceMetadata } from '../../../dist/state/skarbiec-records.js';

async function serviceCredentialProbe() {
  const rows = listServiceMetadata().filter((row) =>
    String(row.display_name ?? row.id ?? '').toLowerCase().includes('pangram'));
  return {
    available: rows.length > 0,
    rows: rows.map((row) => ({
      display_name: row.display_name ?? row.id,
      source: 'skarbiec',
    })),
  };
}

const acct = await getSocialAccount('pangram');
if (!acct) {
  console.log(JSON.stringify({ platform: 'pangram', account: null, reason: 'no active Skarbiec account', service_credentials: await serviceCredentialProbe() }, null, 2));
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
