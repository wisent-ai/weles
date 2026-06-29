// Safely add ONE host record to a Namecheap-managed domain. Namecheap's only
// DNS write API (setHosts) replaces the whole zone, so this reads every record
// via getHosts, appends the new one (if absent), re-sends all records, and
// verifies the count grew by exactly one. Creds come from weles/.env.
//
// Env/args: SLD (default wisent), TLD (default com), NEW_HOST (e.g. oko),
//   NEW_TYPE (default A), NEW_ADDRESS (default 76.76.21.21), NEW_TTL (1800).
import { readFileSync } from 'node:fs';

const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
const cfg = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim().replace(/^"|"$/g, '');
const AK = cfg('NAMECHEAP_API_KEY'), AU = cfg('NAMECHEAP_API_USER'), UN = cfg('NAMECHEAP_USERNAME'), IP = cfg('NAMECHEAP_CLIENT_IP');
if (!AK || !AU || !UN || !IP) { console.log('FAIL: missing Namecheap creds'); process.exit(1); }

const SLD = process.env.SLD || 'wisent';
const TLD = process.env.TLD || 'com';
const NEW = { Name: process.env.NEW_HOST || 'oko', Type: process.env.NEW_TYPE || 'A', Address: process.env.NEW_ADDRESS || '76.76.21.21', TTL: process.env.NEW_TTL || '1800', MXPref: '10' };
const BASE = 'https://api.namecheap.com/xml.response';

async function getHosts() {
  const u = `${BASE}?ApiUser=${AU}&ApiKey=${AK}&UserName=${UN}&Command=namecheap.domains.dns.getHosts&ClientIp=${IP}&SLD=${SLD}&TLD=${TLD}`;
  const xml = await (await fetch(u)).text();
  if (!/Status="OK"/.test(xml)) throw new Error('getHosts not OK: ' + (xml.match(/<Error[^>]*>([^<]*)/)?.[1] || xml.slice(0, 200)));
  const emailType = xml.match(/EmailType="([^"]*)"/)?.[1] || 'MX';
  const hosts = [];
  for (const m of xml.matchAll(/<host\b([^>]*?)\/?>/gi)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&')]));
    hosts.push({ Name: a.Name, Type: a.Type, Address: a.Address, TTL: a.TTL || '1800', MXPref: a.MXPref || '10' });
  }
  return { hosts, emailType };
}

const before = await getHosts();
console.log(`getHosts: ${before.hosts.length} records, EmailType=${before.emailType}`);
const exists = before.hosts.some((h) => h.Name === NEW.Name && h.Type === NEW.Type && h.Address.replace(/\.$/, '') === NEW.Address.replace(/\.$/, ''));
if (exists) { console.log(`NOOP: ${NEW.Name} ${NEW.Type} ${NEW.Address} already present`); process.exit(0); }

const all = [...before.hosts, NEW];
const body = new URLSearchParams({ ApiUser: AU, ApiKey: AK, UserName: UN, Command: 'namecheap.domains.dns.setHosts', ClientIp: IP, SLD, TLD, EmailType: before.emailType });
all.forEach((h, i) => {
  const n = i + 1;
  body.set(`HostName${n}`, h.Name);
  body.set(`RecordType${n}`, h.Type);
  body.set(`Address${n}`, h.Address);
  body.set(`TTL${n}`, h.TTL);
  if (h.Type === 'MX') body.set(`MXPref${n}`, h.MXPref);
});
console.log(`setHosts: sending ${all.length} records (adding ${NEW.Name} ${NEW.Type} ${NEW.Address})`);
const resXml = await (await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })).text();
const ok = /<DomainDNSSetHostsResult[^>]*IsSuccess="true"/.test(resXml) || /Status="OK"/.test(resXml);
if (!ok) { console.log('FAIL setHosts: ' + (resXml.match(/<Error[^>]*>([^<]*)/)?.[1] || resXml.slice(0, 300))); process.exit(1); }

const after = await getHosts();
const present = after.hosts.some((h) => h.Name === NEW.Name && h.Type === NEW.Type);
console.log(`verify: ${after.hosts.length} records (was ${before.hosts.length}); ${NEW.Name} present=${present}`);
if (after.hosts.length === before.hosts.length + 1 && present) console.log('PASS');
else { console.log('WARN: unexpected record count/state — check zone'); process.exit(1); }
