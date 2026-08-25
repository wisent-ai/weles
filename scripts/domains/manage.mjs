#!/usr/bin/env node
// Manage Weles inbound-domain state stored in Skarbiec.
const { readDomainRows, writeDomainRows } = await import('../../dist/utils/email/domain.js');
const now = () => new Date().toISOString();
const [command, domain, extra] = process.argv.slice(2);
const rows = readDomainRows();
const row = domain ? rows.find((candidate) => candidate.domain === domain) : null;

switch (command) {
  case 'list':
    if (!rows.length) console.log('(no domains in rotator)');
    for (const item of [...rows].sort((left, right) => String(right.last_used_at ?? '').localeCompare(String(left.last_used_at ?? '')))) {
      console.log(`  ${item.domain.padEnd(30)} ${item.status.padEnd(9)} signups=${String(item.signup_count ?? 0).padStart(4)} blocks=${item.block_count ?? 0}`);
    }
    break;
  case 'add': {
    if (!domain) throw new Error('Usage: add <domain> [years]');
    const { provisionDomain } = await import('../../dist/utils/email/provision.js');
    const result = await provisionDomain(domain, { years: extra ? Number.parseInt(extra, 10) : 1 });
    console.log(`Added ${domain}: charged=$${result.chargedUsd.toFixed(2)} resend_id=${result.resendId} verified=${result.verified}`);
    break;
  }
  case 'verify':
    if (!row) throw new Error(`domain is absent: ${domain ?? ''}`);
    Object.assign(row, { status: 'active', mx_configured_at: now(), resend_verified_at: now(), updated_at: now() });
    writeDomainRows(rows);
    console.log(`${domain} → active`);
    break;
  case 'block':
    if (!row) throw new Error(`domain is absent: ${domain ?? ''}`);
    Object.assign(row, {
      status: 'blocked',
      block_count: (row.block_count ?? 0) + 1,
      last_block_at: now(),
      metadata: { ...(row.metadata ?? {}), last_block_reason: extra ?? 'manual' },
      updated_at: now(),
    });
    writeDomainRows(rows);
    console.log(`${domain} → blocked`);
    break;
  case 'retire':
    if (!row) throw new Error(`domain is absent: ${domain ?? ''}`);
    Object.assign(row, { status: 'retired', updated_at: now() });
    writeDomainRows(rows);
    console.log(`${domain} → retired`);
    break;
  case 'recheck': {
    const { resolveMx } = await import('node:dns/promises');
    let recovered = 0;
    for (const item of rows.filter((candidate) => candidate.status === 'mx_broken')) {
      let valid = false;
      for (let attempt = 0; attempt < 3 && !valid; attempt += 1) {
        try { valid = (await resolveMx(item.domain)).length > 0; } catch { valid = false; }
        if (!valid && attempt < 2) {
          const { promise, resolve } = Promise.withResolvers();
          setTimeout(resolve, 600);
          await promise;
        }
      }
      if (valid) { item.status = 'active'; item.updated_at = now(); recovered += 1; }
    }
    writeDomainRows(rows);
    console.log(`Recovered ${recovered} domains.`);
    break;
  }
  default:
    throw new Error('Usage: list | add <domain> [years] | verify <domain> | block <domain> [reason] | retire <domain> | recheck');
}
