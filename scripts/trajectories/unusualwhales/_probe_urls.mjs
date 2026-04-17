// Probe which unusualwhales.com/stock/<TICKER>/<PATH> URLs exist and serve
// authenticated content. Logs in once, navigates to each candidate, reports a
// JSON array to stdout so we can prune PAGE_URLS in scrape.mjs.
// Usage: node scripts/trajectories/unusualwhales/_probe_urls.mjs --ticker ORCL

console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
const { WSession } = await import('../../../dist/session/wsession.js');
const { loadEnv } = await import('./_envload.mjs');
loadEnv();

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const ticker = (args.ticker || 'ORCL').toUpperCase();

const email = process.env.UW_EMAIL;
const password = process.env.UW_PASSWORD;
if (!email || !password) { console.error('FAIL: creds'); process.exit(1); }

const paths = [
  'overview',
  'flow-overview',
  'dark-pool',
  'greeks',
  'chains',
  'insider',
  'congress',
  'volatility',
  'short-interest',
  'news',
  'fundamentals',
  'analysts',
];

const s = await WSession.start({ label: `uw_probe_${ticker}`, proxy: process.env.PROXY_URL || 'oxylabs' });

async function login() {
  await s.goto('https://unusualwhales.com/login');
  for (let i = 0; i < 30; i++) {
    const c = await s.page.evaluate('document.querySelectorAll("input").length').catch(() => 0);
    if (c >= 2) break;
    await s.wait(1);
  }
  const inputs = await s.page.evaluate(`(() => Array.from(document.querySelectorAll('input')).map(i => ({ name: i.name, type: i.type, ph: i.placeholder })))()`);
  const em = inputs.find(i => i.type === 'email' || i.name === 'email' || /email|address/i.test(i.ph || ''));
  const pw = inputs.find(i => i.type === 'password' || i.name === 'password');
  const sel = (i) => i.name ? `input[name="${i.name}"]` : `input[placeholder="${i.ph}"]`;
  const fill = (se, v) => s.page.evaluate(`(({ sel, val }) => { const el = document.querySelector(sel); el.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })(${JSON.stringify({ sel: se, val: v })})`);
  await fill(sel(em), email); await s.wait(1);
  await fill(sel(pw), password); await s.wait(1);
  await s.page.evaluate(`(() => { const b = document.querySelector('button[type="submit"], input[type="submit"]'); if (b) b.click(); else document.querySelector('form')?.requestSubmit(); })()`);
  for (let i = 0; i < 30; i++) { await s.wait(2); if (!s.page.url().includes('/login')) return; }
  throw new Error('login did not redirect');
}

async function probe(path) {
  const url = `https://unusualwhales.com/stock/${ticker}/${path}`;
  await s.goto(url);
  let len = 0;
  for (let i = 0; i < 20; i++) {
    len = await s.page.evaluate('document.body?.innerText?.length || 0').catch(() => 0);
    if (len > 500) break;
    await s.wait(1);
  }
  await s.wait(2);
  const info = await s.page.evaluate(`(() => ({
    finalUrl: location.pathname + location.search,
    title: document.title,
    bodyLen: (document.body?.innerText || '').length,
    has404: /404|not found|page not found/i.test(document.body?.innerText || ''),
    hasSignIn: /Sign In/.test(document.body?.innerText || ''),
    heading: document.querySelector('h1, h2')?.innerText?.trim() || null,
  }))()`).catch((e) => ({ err: e.message }));
  return { path, url, ...info };
}

try {
  await login();
  await s.wait(3);
  const results = [];
  for (const p of paths) {
    const r = await probe(p);
    console.error(`[probe] ${p}: finalUrl=${r.finalUrl} bodyLen=${r.bodyLen} has404=${r.has404} heading=${JSON.stringify(r.heading)}`);
    results.push(r);
  }
  process.stdout.write(JSON.stringify({ ticker, results }, null, 2) + '\n');
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
