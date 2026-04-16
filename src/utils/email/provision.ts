/**
 * Auto-provisioner for new inbound email domains.
 *
 * Pipeline:
 *   1. Namecheap availability check
 *   2. Namecheap register (MAX_PRICE guarded)
 *   3. Resend POST /v1/domains with receiving enabled
 *   4. Resend returns DNS records; set them via Namecheap
 *   5. Poll Resend until status=verified
 *   6. Insert into inbound_email_domains as active
 */

const MAX_PRICE_USD = 20;

type NcEnv = { apiKey: string; apiUser: string; username: string; clientIp: string };

function ncEnv(): NcEnv {
  const apiKey = process.env.NAMECHEAP_API_KEY ?? '';
  const apiUser = process.env.NAMECHEAP_API_USER ?? '';
  const username = process.env.NAMECHEAP_USERNAME ?? apiUser;
  const clientIp = process.env.NAMECHEAP_CLIENT_IP ?? '';
  if (!apiKey || !apiUser || !username || !clientIp) {
    throw new Error('Missing NAMECHEAP_API_KEY / NAMECHEAP_API_USER / NAMECHEAP_USERNAME / NAMECHEAP_CLIENT_IP');
  }
  return { apiKey, apiUser, username, clientIp };
}

function ncBase(sandbox = false): string {
  return sandbox ? 'https://api.sandbox.namecheap.com/xml.response' : 'https://api.namecheap.com/xml.response';
}

async function ncCall(command: string, extra: Record<string, string>, sandbox = false): Promise<string> {
  const env = ncEnv();
  const url = new URL(ncBase(sandbox));
  url.searchParams.set('ApiUser', env.apiUser);
  url.searchParams.set('ApiKey', env.apiKey);
  url.searchParams.set('UserName', env.username);
  url.searchParams.set('ClientIp', env.clientIp);
  url.searchParams.set('Command', command);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const body = await res.text();
  if (!res.ok) throw new Error(`Namecheap ${command} HTTP ${res.status}: ${body.slice(0, 300)}`);
  const errorMatch = body.match(/<Error[^>]*>([^<]+)<\/Error>/);
  if (errorMatch) throw new Error(`Namecheap ${command} error: ${errorMatch[1]}`);
  return body;
}

export async function checkDomain(domain: string): Promise<{ available: boolean; premium: boolean }> {
  const xml = await ncCall('namecheap.domains.check', { DomainList: domain });
  const available = /Available="true"/i.test(xml);
  const premium = /IsPremiumName="true"/i.test(xml);
  return { available, premium };
}

export async function registerDomain(domain: string, years = 1, contact?: Partial<Record<string, string>>): Promise<{ chargedUsd: number; domainId: string | null }> {
  const avail = await checkDomain(domain);
  if (!avail.available) throw new Error(`${domain} is not available`);
  if (avail.premium) throw new Error(`${domain} is a premium domain — refusing to buy`);

  const c = {
    FirstName: 'Wisent', LastName: 'Media',
    Address1: '548 Market St', City: 'San Francisco',
    StateProvince: 'CA', PostalCode: '94104',
    Country: 'US', Phone: '+1.4155551234',
    EmailAddress: 'ops@wisentmedia.com',
    ...contact,
  };
  const params: Record<string, string> = { DomainName: domain, Years: String(years) };
  for (const prefix of ['Registrant', 'Tech', 'Admin', 'AuxBilling']) {
    for (const [k, v] of Object.entries(c)) params[`${prefix}${k}`] = v as string;
  }
  const xml = await ncCall('namecheap.domains.create', params);
  const registered = /Registered="true"/i.test(xml);
  if (!registered) throw new Error('Registration response did not report Registered=true');
  const charged = parseFloat(xml.match(/ChargedAmount="([\d.]+)"/)?.[1] ?? '0');
  if (charged > MAX_PRICE_USD) throw new Error(`Charged $${charged} exceeds max $${MAX_PRICE_USD}`);
  const domainId = xml.match(/DomainID="(\d+)"/)?.[1] ?? null;
  return { chargedUsd: charged, domainId };
}

interface ResendDnsRecord { record: string; name: string; type: string; value: string; ttl?: string | number; priority?: number; status?: string }
interface ResendDomain { id: string; name: string; status: string; records: ResendDnsRecord[] }

export async function createResendDomain(domain: string, region = 'us-east-1'): Promise<ResendDomain> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Missing RESEND_API_KEY');
  const res = await fetch('https://api.resend.com/domains', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: domain, region }),
  });
  const body = await res.json() as ResendDomain & { message?: string };
  if (!res.ok) throw new Error(`Resend create domain: ${res.status} ${body.message ?? JSON.stringify(body)}`);
  return body;
}

export async function enableResendReceiving(domainId: string): Promise<ResendDomain> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Missing RESEND_API_KEY');
  const res = await fetch(`https://api.resend.com/domains/${domainId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ capabilities: { receiving: 'enabled' } }),
  });
  if (!res.ok) throw new Error(`Resend enable receiving: ${res.status} ${await res.text()}`);
  return getResendDomain(domainId);
}

export async function getResendDomain(domainId: string): Promise<ResendDomain> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Missing RESEND_API_KEY');
  const res = await fetch(`https://api.resend.com/domains/${domainId}`, { headers: { Authorization: `Bearer ${key}` } });
  const body = await res.json() as ResendDomain & { message?: string };
  if (!res.ok) throw new Error(`Resend get domain: ${res.status} ${body.message ?? ''}`);
  return body;
}

export async function setNamecheapHosts(domain: string, records: ResendDnsRecord[]): Promise<void> {
  const parts = domain.split('.');
  if (parts.length < 2) throw new Error('Invalid domain');
  const SLD = parts[0];
  const TLD = parts.slice(1).join('.');
  // EmailType=MX tells Namecheap to honor custom MX records in the hosts list
  const params: Record<string, string> = { SLD, TLD, EmailType: 'MX' };
  records.forEach((r, i) => {
    const n = i + 1;
    const host = r.name.endsWith(`.${domain}`) ? r.name.slice(0, -domain.length - 1) : r.name === domain ? '@' : r.name;
    params[`HostName${n}`] = host || '@';
    params[`RecordType${n}`] = r.type.toUpperCase();
    params[`Address${n}`] = r.value;
    if (r.type.toUpperCase() === 'MX') params[`MXPref${n}`] = String(r.priority ?? 10);
    const numericTtl = typeof r.ttl === 'number' ? r.ttl : parseInt(String(r.ttl ?? ''), 10);
    params[`TTL${n}`] = String(Number.isFinite(numericTtl) && numericTtl > 0 ? numericTtl : 1800);
  });
  await ncCall('namecheap.domains.dns.setHosts', params);
}

export async function verifyResendDomain(domainId: string, pollSeconds = 20, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const d = await getResendDomain(domainId);
    if (d.status === 'verified') return true;
    if (d.status === 'failed') throw new Error('Resend domain verification failed');
    await new Promise(r => setTimeout(r, pollSeconds * 1000));
  }
  return false;
}

export async function insertRotatorRow(domain: string, resendId: string, chargedUsd: number, status: 'pending' | 'active' = 'active'): Promise<void> {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('Missing Supabase creds');
  const now = new Date().toISOString();
  const row = {
    domain,
    status,
    provider: 'namecheap',
    registered_at: now,
    mx_configured_at: now,
    resend_verified_at: status === 'active' ? now : null,
    metadata: { resend_id: resendId, charged_usd: chargedUsd },
    updated_at: now,
  };
  const res = await fetch(`${url}/rest/v1/inbound_email_domains`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase upsert: ${res.status} ${await res.text()}`);
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
  console.log(`[provision] Step 5/6 — polling Resend for verification (up to 10 min)`);
  const verified = await verifyResendDomain(resendDomain.id);
  console.log(`[provision]   verified=${verified}`);
  console.log(`[provision] Step 6/6 — inserting rotator row (status=${verified ? 'active' : 'pending'})`);
  await insertRotatorRow(domain, resendDomain.id, reg.chargedUsd, verified ? 'active' : 'pending');
  return { chargedUsd: reg.chargedUsd, resendId: resendDomain.id, verified };
}
