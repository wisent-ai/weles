// Drive PH's Twitter OAuth via raw HTTP fetch — no browser rendering at all.
// Captures the PH session cookie from Set-Cookie headers along the redirect
// chain. Sidesteps the weles renderer crash entirely.

const supaUrl = process.env.SUPABASE_URL ?? '';
const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

async function getAccount(platform) {
  const r = await fetch(`${supaUrl}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=username,metadata&order=created_at.desc&limit=1`,
    { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }).then(r => r.json());
  return r?.[0];
}

function cookieJarFrom(cookies) {
  const jar = {};
  for (const c of cookies) {
    const d = c.domain || '';
    if (!jar[d]) jar[d] = {};
    jar[d][c.name] = c.value;
  }
  return jar;
}

function cookieHeaderFor(hostname, jar) {
  const parts = [];
  for (const [domain, kv] of Object.entries(jar)) {
    const d = domain.startsWith('.') ? domain.slice(1) : domain;
    if (hostname === d || hostname.endsWith('.' + d)) {
      for (const [k, v] of Object.entries(kv)) parts.push(`${k}=${v}`);
    }
  }
  return parts.join('; ');
}

function mergeSetCookies(sc, defaultDomain, jar) {
  for (const line of sc) {
    const [kv, ...attrs] = line.split(';').map(s => s.trim());
    const eqIdx = kv.indexOf('=');
    if (eqIdx < 0) continue;
    const name = kv.slice(0, eqIdx).trim();
    const value = kv.slice(eqIdx + 1).trim();
    let domain = defaultDomain;
    for (const a of attrs) {
      const [ak, av] = a.split('=').map(s => s?.trim());
      if (ak?.toLowerCase() === 'domain' && av) domain = av.startsWith('.') ? av : '.' + av;
    }
    if (!jar[domain]) jar[domain] = {};
    jar[domain][name] = value;
  }
}

async function httpGet(url, jar, extraHeaders = {}) {
  const hostname = new URL(url).hostname;
  const cookie = cookieHeaderFor(hostname, jar);
  const headers = {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    ...(cookie ? { cookie } : {}),
    ...extraHeaders,
  };
  const r = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
  const sc = r.headers.getSetCookie?.() ?? [];
  mergeSetCookies(sc, '.' + hostname, jar);
  return r;
}

const tw = await getAccount('twitter');
const ph = await getAccount('producthunt');
const jar = cookieJarFrom([...(ph?.metadata?.cookies ?? []), ...(tw?.metadata?.cookies ?? [])]);
console.log(`[http] starting OAuth with tw=${tw?.username} ph=${ph?.username}`);
console.log(`[http] jar domains: ${Object.keys(jar).join(', ')}`);

let resp = await httpGet('https://www.producthunt.com/auth/twitter?origin=%2F&source_component=DesktopHeader', jar);
console.log(`[http] step 1: ${resp.status} -> ${resp.headers.get('location')?.slice(0, 120)}`);
let loc = resp.headers.get('location');
let currentUrl = 'https://www.producthunt.com/auth/twitter';
for (let step = 2; step < 15 && loc; step++) {
  const absUrl = loc.startsWith('http') ? loc : new URL(loc, currentUrl).toString();
  resp = await httpGet(absUrl, jar);
  currentUrl = absUrl;
  console.log(`[http] step ${step}: ${resp.status} ${absUrl.slice(0, 70)} -> ${resp.headers.get('location')?.slice(0, 80) || '(no redirect)'}`);
  loc = resp.headers.get('location');
  if (resp.status >= 200 && resp.status < 300) break;
}

console.log(`\n[http] producthunt cookies after chain:`);
for (const [domain, kv] of Object.entries(jar)) {
  if (!domain.includes('producthunt')) continue;
  for (const [k, v] of Object.entries(kv)) {
    console.log(`  ${domain} ${k} = ${String(v).slice(0, 40)}${String(v).length > 40 ? '...' : ''}`);
  }
}
const ses = (jar['.producthunt.com']?._producthunt_session_production) || (jar['www.producthunt.com']?._producthunt_session_production);
console.log(`\n[http] session cookie: ${ses ? 'CAPTURED ✓ (' + ses.slice(0, 40) + '...)' : 'MISSING ✗'}`);
