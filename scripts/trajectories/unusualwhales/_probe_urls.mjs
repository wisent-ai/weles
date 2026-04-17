// Extract every internal URL from the authenticated UW sidebar/page.
// Usage: node scripts/trajectories/unusualwhales/_probe_urls.mjs [--ticker ORCL]

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

async function collectLinks() {
  return await s.page.evaluate(`(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('/') && !href.startsWith('https://unusualwhales.com')) continue;
      const path = href.replace(/^https:\\/\\/unusualwhales\\.com/, '');
      if (!path || path === '/') continue;
      const text = (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80);
      out.push({ path, text });
    }
    return out;
  })()`);
}

try {
  await login();
  await s.wait(3);

  // 1) Sidebar links from the authenticated home page (flow/overview)
  // Expand every collapsed sidebar category so their children become visible.
  const expandCats = `(() => {
    const items = Array.from(document.querySelectorAll('[class*="sidebar"] [role="button"], [class*="sidebar"] button, [class*="Sidebar"] [role="button"], [class*="Sidebar"] button, nav [role="button"], nav button'));
    const clicked = [];
    for (const el of items) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 40) continue;
      try { el.click(); clicked.push(t); } catch (_) {}
    }
    return clicked;
  })()`;
  const expandedHome = await s.page.evaluate(expandCats).catch(() => []);
  console.error(`[probe] expanded ${expandedHome.length} sidebar items on home`);
  await s.wait(2);
  const homeLinks = await collectLinks();

  // Also capture every visible nav/sidebar element text so we know which
  // labels exist even if they're buttons, not anchors.
  const navLabels = await s.page.evaluate(`(() => {
    const seen = new Set();
    for (const el of document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]')) {
      const t = (el.innerText || '').trim();
      if (t && t.length > 0 && t.length < 50) seen.add(t);
    }
    return Array.from(seen);
  })()`).catch(() => []);

  // 2) Links from the stock-specific page (to catch any ticker-scoped routes)
  await s.goto(`https://unusualwhales.com/stock/${ticker}/overview`);
  for (let i = 0; i < 20; i++) {
    const len = await s.page.evaluate('document.body?.innerText?.length || 0').catch(() => 0);
    if (len > 500) break;
    await s.wait(1);
  }
  await s.wait(3);
  await s.page.evaluate(expandCats).catch(() => []);
  await s.wait(2);
  const stockLinks = await collectLinks();

  // Deduplicate, keep text
  const seen = new Map();
  for (const l of [...homeLinks, ...stockLinks]) {
    if (!seen.has(l.path)) seen.set(l.path, l.text);
  }
  const all = Array.from(seen.entries()).map(([path, text]) => ({ path, text }));

  // Bucket by top-level segment
  const buckets = {};
  for (const l of all) {
    const top = l.path.split('?')[0].split('/').filter(Boolean)[0] || '';
    if (!buckets[top]) buckets[top] = [];
    buckets[top].push(l);
  }

  process.stdout.write(JSON.stringify({ ticker, total: all.length, buckets, all, navLabels }, null, 2) + '\n');
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
