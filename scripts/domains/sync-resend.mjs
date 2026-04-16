#!/usr/bin/env node
// Sync receiving-enabled domains from Resend into the rotator table.
// Inserts as status=pending so you can review + verify selectively.

const resendKey = process.env.RESEND_API_KEY;
const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!resendKey || !sbUrl || !sbKey) { console.error('Missing RESEND_API_KEY or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${resendKey}` } });
if (!res.ok) { console.error(`Resend list failed: ${res.status}`); process.exit(1); }
const { data: domains = [] } = await res.json();

const receiving = domains.filter(d => d.capabilities?.receiving === 'enabled' && d.status === 'verified');
console.log(`Resend has ${domains.length} total domains, ${receiving.length} receiving-enabled and verified`);

const hdr = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };
const base = `${sbUrl}/rest/v1/inbound_email_domains`;
let added = 0, existing = 0, failed = 0;

for (const d of receiving) {
  const check = await fetch(`${base}?domain=eq.${encodeURIComponent(d.name)}&select=domain,status`, { headers: hdr });
  const rows = await check.json();
  if (rows.length) {
    console.log(`  ${d.name.padEnd(40)} (already in table, status=${rows[0].status})`);
    existing++;
    continue;
  }
  const now = new Date().toISOString();
  const body = {
    domain: d.name,
    status: 'pending',
    provider: 'resend',
    mx_configured_at: now,
    resend_verified_at: now,
    registered_at: d.created_at,
    metadata: { resend_id: d.id, region: d.region },
    updated_at: now,
  };
  const ins = await fetch(base, {
    method: 'POST',
    headers: { ...hdr, Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (ins.ok) {
    console.log(`  ${d.name.padEnd(40)} added (status=pending) — run "verify ${d.name}" to activate`);
    added++;
  } else {
    console.log(`  ${d.name.padEnd(40)} FAILED: ${ins.status} ${await ins.text()}`);
    failed++;
  }
}

console.log(`\nSummary: ${added} added, ${existing} already present, ${failed} failed`);
