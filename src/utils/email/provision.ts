import { readDomainRows, writeDomainRows } from './domain.js';
import { integrationAction } from '../integrations.js';

/**
 * Auto-provisioner for new inbound email domains.
 *
 * Pipeline (every provider call goes through wisent-integrations'
 * `email-domains` actions, which hold the Namecheap and Resend keys):
 *   1. Namecheap availability check
 *   2. Namecheap register (premium and taken names refused by the boundary;
 *      a charge above its limit is reported and stops the pipeline)
 *   3. Resend domain created with receiving enabled
 *   4. Resend's DNS records set via Namecheap
 *   5. Poll Resend until status=verified
 *   6. Insert into inbound_email_domains as active
 */

export async function checkDomain(domain: string): Promise<{ available: boolean; premium: boolean }> {
  return integrationAction<{ available: boolean; premium: boolean }>('email-domains', 'namecheap.domain.check', { domain });
}

export async function registerDomain(domain: string, years = 1): Promise<{ chargedUsd: number; domainId: string | null }> {
  const registered = await integrationAction<{ domain_id: string | null; charged_usd: number; over_limit: boolean }>(
    'email-domains', 'namecheap.domain.register', { domain, years },
  );
  if (registered.over_limit) throw new Error(`Registering ${domain} charged $${registered.charged_usd}, above the boundary's limit`);
  return { chargedUsd: registered.charged_usd, domainId: registered.domain_id };
}

interface ResendDnsRecord { record: string; name: string; type: string; value: string; ttl?: string | number; priority?: number; status?: string }
interface ResendDomain { id: string; name: string; status: string; records: ResendDnsRecord[] }

export async function createResendDomain(domain: string, region = 'us-east-1'): Promise<ResendDomain> {
  return integrationAction<ResendDomain>('email-domains', 'resend.domain.create', { domain, region });
}

export async function enableResendReceiving(domainId: string): Promise<ResendDomain> {
  return integrationAction<ResendDomain>('email-domains', 'resend.domain.receiving.enable', { id: domainId });
}

export async function getResendDomain(domainId: string): Promise<ResendDomain> {
  return integrationAction<ResendDomain>('email-domains', 'resend.domain.get', { id: domainId });
}

export async function setNamecheapHosts(domain: string, records: ResendDnsRecord[]): Promise<void> {
  await integrationAction('email-domains', 'namecheap.dns.hosts.set', {
    domain,
    records: records.map((record) => {
      const numericTtl = typeof record.ttl === 'number' ? record.ttl : parseInt(String(record.ttl ?? ''), 10);
      return {
        name: record.name,
        type: record.type,
        value: record.value,
        ...(Number.isFinite(numericTtl) && numericTtl > 0 ? { ttl: numericTtl } : {}),
        ...(record.priority !== undefined ? { priority: record.priority } : {}),
      };
    }),
  });
}

// One status read. Resend verifies DNS on its own schedule; a domain that is
// not verified yet is stored as pending and promoted by the next status check.
export async function verifyResendDomain(domainId: string): Promise<boolean> {
  const d = await getResendDomain(domainId);
  if (d.status === 'failed') throw new Error(`resend_domain_verification_failed: ${domainId}`);
  if (d.status !== 'verified') console.log(`[provision] resend_domain_pending: ${domainId} status=${d.status}`);
  return d.status === 'verified';
}

export async function insertRotatorRow(domain: string, resendId: string, chargedUsd: number, status: 'pending' | 'active' = 'active'): Promise<void> {
  const rows = readDomainRows();
  const now = new Date().toISOString();
  const next = {
    domain,
    status,
    provider: 'namecheap',
    signup_count: 0,
    block_count: 0,
    registered_at: now,
    mx_configured_at: now,
    resend_verified_at: status === 'active' ? now : null,
    metadata: { resend_id: resendId, charged_usd: chargedUsd },
    updated_at: now,
  };
  const index = rows.findIndex((row) => row.domain === domain);
  if (index >= 0) rows[index] = { ...rows[index], ...next };
  else rows.push(next);
  writeDomainRows(rows);
}

export async function provisionDomain(domain: string, opts: { years?: number; region?: string } = {}): Promise<{ chargedUsd: number; resendId: string; verified: boolean }> {
  const { years = 1, region = 'us-east-1' } = opts;
  console.log(`[provision] Step 1/6 — checking ${domain}`);
  await checkDomain(domain);
  console.log(`[provision] Step 2/6 — registering ${domain} for ${years}y`);
  const reg = await registerDomain(domain, years);
  console.log(`[provision]   charged $${reg.chargedUsd.toFixed(2)}`);
  console.log(`[provision] Step 3/6 — creating Resend domain (region=${region}) and enabling receiving`);
  const created = await createResendDomain(domain, region);
  const resendDomain = await enableResendReceiving(created.id);
  console.log(`[provision]   resend id ${resendDomain.id}, ${resendDomain.records.length} DNS records`);
  console.log(`[provision] Step 4/6 — writing DNS records to Namecheap`);
  await setNamecheapHosts(domain, resendDomain.records);
  console.log(`[provision] Step 5/6 — reading Resend verification status`);
  const verified = await verifyResendDomain(resendDomain.id);
  console.log(`[provision]   verified=${verified}`);
  console.log(`[provision] Step 6/6 — inserting rotator row (status=${verified ? 'active' : 'pending'})`);
  await insertRotatorRow(domain, resendDomain.id, reg.chargedUsd, verified ? 'active' : 'pending');
  return { chargedUsd: reg.chargedUsd, resendId: resendDomain.id, verified };
}

// Re-export from suggest.ts — LLM-driven topical domain name generation
export { suggestDomainName } from './suggest.js';
