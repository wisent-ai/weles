/**
 * Audit each proxy provider. Fetches exit IP via the proxy, whois-s the IP,
 * classifies as residential-ISP / mobile / datacenter-cloud / proxy-
 * marketplace, probes target sites. Ranks providers so the rest of the code
 * can pick based on empirical data instead of blindly hashing account IDs.
 */
import { resolveProxy } from '../../dist/proxy/config.js';
import { execSync } from 'node:child_process';

const PROXY_RESELLERS = /ipxo|rocks computer|bright vps|netutils|cogent|hostroyale|datacamp|m247|hivelocity|leaseweb|hosthatch|swift packets|6connect|abelohost|eonix/i;
const REAL_ISPS = /comcast|verizon|at&t|t-mobile|sprint|charter|spectrum|cox communic|frontier|centurylink|optimum|altice|virgin media|vodafone|orange|telef[oó]nica|deutsche telekom|free mobile|sfr|bouygues|telekom|kpn|sky uk|talk talk|bt group|reliance jio|airtel|kddi|softbank|ntt docomo|china (mobile|telecom|unicom)|rakuten|telstra|optus|tpg|rogers|bell canada|telus|chunghwa|hinet/i;
const MOBILE_CARRIERS = /mobile|wireless|cellular|m-net|airtel|vodafone (mobile|wireless)/i;
const CLOUDS = /digitalocean|amazon|aws|google|microsoft|azure|hetzner|ovh|linode|alibaba|tencent|oracle cloud|ibm cloud|vultr|scaleway/i;

async function whoisOrg(ip) {
  try {
    const out = execSync(`whois ${ip}`, { encoding: 'utf8' });
    const lines = out.split('\n');
    const org = lines.find(l => /^(orgname|organisation|org-name|owner|netname|descr):\s*\S/i.test(l))?.split(':')[1]?.trim() ?? '';
    const country = lines.find(l => /^country:/i.test(l))?.split(':')[1]?.trim() ?? '';
    return { org, country };
  } catch { return { org: '', country: '' }; }
}

function classify(org) {
  if (!org) return 'unknown';
  if (CLOUDS.test(org)) return 'datacenter-cloud';
  if (PROXY_RESELLERS.test(org)) return 'proxy-marketplace';
  if (MOBILE_CARRIERS.test(org)) return 'mobile';
  if (REAL_ISPS.test(org)) return 'residential-isp';
  if (/llc|services|hosting|ltd\.?$|s\.r\.o\.|sas$|inc\.?$|gmbh/i.test(org)) return 'proxy-marketplace?';
  return 'unknown';
}

function rankCat(category) {
  return ({ 'residential-isp': 5, 'mobile': 4, 'datacenter-cloud': 3, 'unknown': 2, 'proxy-marketplace?': 1, 'proxy-marketplace': 0 })[category] ?? 0;
}

async function probeTarget(proxyUrl, target) {
  const u = new URL(proxyUrl);
  const cred = u.username ? `${u.username}:${u.password}` : '';
  try {
    const out = execSync(`curl -s -o /dev/null -w "%{http_code}|%{time_total}" --max-time 12 -x "http://${cred}@${u.hostname}:${u.port}" -H "User-Agent: Mozilla/5.0" -L "${target}"`, { encoding: 'utf8' });
    const [code, time] = out.split('|');
    return { code, time: parseFloat(time).toFixed(2) };
  } catch { return { code: '000', time: '-' }; }
}

async function auditProvider(filter, label) {
  process.env.PROXY_SKIP_PREFLIGHT = '1';
  const cfg = await resolveProxy(filter).catch(() => null);
  if (!cfg) { console.log(`${label.padEnd(22)} | NO_CONFIG (no balance / no creds)`); return null; }
  const u = new URL(cfg.server);
  const proxyAuth = `${u.protocol}//${encodeURIComponent(cfg.username || '')}:${encodeURIComponent(cfg.password || '')}@${u.hostname}:${u.port}`;
  let exitIp = '';
  try { exitIp = execSync(`curl -s --max-time 12 -x "${proxyAuth}" https://api.ipify.org`, { encoding: 'utf8' }).trim(); } catch { exitIp = ''; }
  if (!exitIp || !/^[0-9.]+$/.test(exitIp)) { console.log(`${label.padEnd(22)} | NO_EXIT (auth/CONNECT failed via ${u.hostname}:${u.port})`); return null; }
  const wh = await whoisOrg(exitIp);
  const cat = classify(wh.org);
  const linkedinProbe = await probeTarget(proxyAuth, 'https://www.linkedin.com/signup');
  const twitterProbe = await probeTarget(proxyAuth, 'https://x.com/i/flow/login');
  const r = { label, exitIp, org: wh.org, country: wh.country, category: cat, rank: rankCat(cat), linkedin: `${linkedinProbe.code}/${linkedinProbe.time}s`, twitter: `${twitterProbe.code}/${twitterProbe.time}s` };
  console.log(`${label.padEnd(22)} | ${exitIp.padEnd(15)} | ${cat.padEnd(20)} | rank=${r.rank} | li=${r.linkedin.padEnd(12)} tw=${r.twitter.padEnd(12)} | "${wh.org.slice(0, 45)}"`);
  return r;
}

console.log('='.repeat(150));
console.log('Provider               | Exit IP         | Category             | Score  | LinkedIn probe / Twitter probe | Org owning the IP');
console.log('='.repeat(150));

const results = [];
const PROVIDERS = 'residential packetstream|residential oxylabs us|residential oxylabs br|mobile oxylabs us|residential pingproxies|residential brightdata|residential iproyal'.split('|').map(f => [f, f]);
for (const [filter, label] of PROVIDERS) {
  const r = await auditProvider(filter, label);
  if (r) results.push(r);
}

console.log('='.repeat(150));
results.sort((a, b) => b.rank - a.rank);
console.log('\nRanked (best first — pick the highest for PerimeterX/Arkose-protected sites):');
for (const r of results) console.log(`  ${r.label.padEnd(22)} → ${r.category.padEnd(22)} (${r.exitIp}) li=${r.linkedin}`);
