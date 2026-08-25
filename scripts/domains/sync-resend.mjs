#!/usr/bin/env node
// Sync receiving-enabled Resend domains into Weles state in Skarbiec.
import { readScopedSecret } from '../_shared/scoped-secrets.mjs';
const { readDomainRows, writeDomainRows } = await import('../../dist/utils/email/domain.js');

const resendKey = readScopedSecret('resendManagement', 'api_key');
if (!resendKey) throw new Error('Missing exact Resend management grant');
const response = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${resendKey}` } });
if (!response.ok) throw new Error(`Resend list failed: ${response.status}`);
const { data: domains = [] } = await response.json();
const receiving = domains.filter((domain) => domain.capabilities?.receiving === 'enabled' && domain.status === 'verified');
const rows = readDomainRows();
let added = 0;
let existing = 0;
for (const domain of receiving) {
  if (rows.some((row) => row.domain === domain.name)) { existing += 1; continue; }
  const timestamp = new Date().toISOString();
  rows.push({
    domain: domain.name,
    status: 'pending',
    provider: 'resend',
    signup_count: 0,
    block_count: 0,
    mx_configured_at: timestamp,
    resend_verified_at: timestamp,
    registered_at: domain.created_at,
    metadata: { resend_id: domain.id, region: domain.region },
    updated_at: timestamp,
  });
  added += 1;
}
writeDomainRows(rows);
console.log(`Resend domains synchronized: ${added} added, ${existing} already present`);
