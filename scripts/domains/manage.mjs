#!/usr/bin/env node
// CLI for the inbound_email_domains rotator table.
// Usage:
//   node scripts/domains/manage.mjs list
//   node scripts/domains/manage.mjs add <domain> [provider]
//   node scripts/domains/manage.mjs verify <domain>
//   node scripts/domains/manage.mjs block <domain> [reason]
//   node scripts/domains/manage.mjs retire <domain>
//   node scripts/domains/manage.mjs recheck            — 3-attempt MX validation for every mx_broken row; auto-promote any that now resolves. Mirrors the auto-heal that pickFromDb runs on each call.

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!url || !key) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

const hdr = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const now = () => new Date().toISOString();
const base = `${url}/rest/v1/inbound_email_domains`;

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...hdr, Prefer: method === 'POST' ? 'return=representation' : 'return=minimal' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) { console.error(`[${method} ${path}] ${res.status}: ${await res.text()}`); process.exit(1); }
  return method === 'POST' ? res.json() : null;
}

const [cmd, domain, extra] = process.argv.slice(2);

switch (cmd) {
  case 'list': {
    const res = await fetch(`${base}?select=*&order=last_used_at.desc.nullslast`, { headers: hdr });
    if (!res.ok) { console.error(`Fetch failed: ${res.status} ${await res.text()}`); process.exit(1); }
    const rows = await res.json();
    if (!rows.length) { console.log('(no domains in rotator)'); break; }
    console.log(`Found ${rows.length} domains:`);
    for (const r of rows) {
      const last = r.last_used_at ? new Date(r.last_used_at).toISOString().slice(0, 19) : 'never';
      const blocks = r.block_count ? ` blocks=${r.block_count}` : '';
      console.log(`  ${r.domain.padEnd(30)} ${r.status.padEnd(9)} signups=${String(r.signup_count).padStart(4)}${blocks}  last=${last}`);
    }
    break;
  }
  case 'add': {
    if (!domain) { console.error('Usage: add <domain> [years]'); process.exit(1); }
    // Auto-provision end-to-end: Namecheap register → Resend domain create +
    // receiving enable → write DNS records to Namecheap → poll Resend until
    // verified → upsert inbound_email_domains row as active. Was previously
    // just an insert-pending stub that required manual `verify` followup.
    const { provisionDomain } = await import('../../dist/utils/email/provision.js');
    const years = extra ? parseInt(extra, 10) : 1;
    const result = await provisionDomain(domain, { years });
    console.log(`Added ${domain}: charged=$${result.chargedUsd.toFixed(2)} resend_id=${result.resendId} verified=${result.verified}`);
    if (!result.verified) console.log(`Row inserted as pending — Resend verification timed out. Re-poll via dist/utils/email/provision.ts:verifyResendDomain or wait and retry.`);
    break;
  }
  case 'verify': {
    if (!domain) { console.error('Usage: verify <domain>'); process.exit(1); }
    await api('PATCH', `?domain=eq.${encodeURIComponent(domain)}`, { status: 'active', mx_configured_at: now(), resend_verified_at: now(), updated_at: now() });
    console.log(`${domain} → active`);
    break;
  }
  case 'block': {
    if (!domain) { console.error('Usage: block <domain> [reason]'); process.exit(1); }
    const res = await fetch(`${base}?domain=eq.${encodeURIComponent(domain)}&select=block_count,metadata`, { headers: hdr });
    const [row] = await res.json();
    const cur = row ?? { block_count: 0, metadata: {} };
    await api('PATCH', `?domain=eq.${encodeURIComponent(domain)}`, {
      status: 'blocked',
      block_count: cur.block_count + 1,
      last_block_at: now(),
      metadata: { ...cur.metadata, last_block_reason: extra ?? 'manual' },
      updated_at: now(),
    });
    console.log(`${domain} → blocked (reason: ${extra ?? 'manual'})`);
    break;
  }
  case 'retire': {
    if (!domain) { console.error('Usage: retire <domain>'); process.exit(1); }
    await api('PATCH', `?domain=eq.${encodeURIComponent(domain)}`, { status: 'retired', updated_at: now() });
    console.log(`${domain} → retired`);
    break;
  }
  case 'recheck': {
    const { resolveMx } = await import('node:dns/promises');
    const res = await fetch(`${base}?status=eq.mx_broken&select=domain,updated_at&order=domain.asc`, { headers: hdr });
    const rows = await res.json();
    console.log(`Found ${rows.length} mx_broken rows; re-validating (3 attempts each, 600ms backoff)...`);
    let recovered = 0;
    for (const r of rows) {
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        try { const recs = await resolveMx(r.domain); if (Array.isArray(recs) && recs.length > 0) ok = true; } catch {}
        if (!ok && i < 2) await new Promise((res2) => setTimeout(res2, 600));
      }
      if (ok) {
        await api('PATCH', `?domain=eq.${encodeURIComponent(r.domain)}`, { status: 'active', updated_at: now() });
        console.log(`  ${r.domain.padEnd(30)} → active (MX resolved)`);
        recovered++;
      } else {
        console.log(`  ${r.domain.padEnd(30)} still mx_broken (3 attempts failed)`);
      }
    }
    console.log(`Recovered ${recovered}/${rows.length} rows.`);
    break;
  }
  default:
    console.log('Usage:');
    console.log('  list                         — show all domains, status, usage');
    console.log('  add <domain> [provider]      — insert pending row');
    console.log('  verify <domain>              — mark active (after MX + Resend verified)');
    console.log('  block <domain> [reason]      — mark blocked (silent throttle, etc.)');
    console.log('  retire <domain>              — permanently remove from rotation');
    console.log('  recheck                      — re-validate every mx_broken row; auto-promote any whose MX now resolves');
    process.exit(1);
}
