// Two modes:
//  (default) extract every internal URL from the authenticated UW sidebar/page.
//  --mode inventory: walk every known per-ticker page and capture interactive
//    elements + screenshot. Output JSON to stdout, PNGs to --out-dir.
// Usage: node src/trajectories/unusualwhales/_probe_urls.mjs [--ticker ORCL]
//        node src/trajectories/unusualwhales/_probe_urls.mjs --mode inventory --ticker ORCL --out-dir /path/to/dir

import fs from 'node:fs';
import path from 'node:path';

console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
const { WSession } = await import('../../../dist/session/wsession.js');
const { loadEnv } = await import('./_envload.mjs');
loadEnv();

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const ticker = (args.ticker || 'ORCL').toUpperCase();
const mode = args.mode || 'links';
const outDir = args['out-dir'] || `/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/trading-tools/screenshots/${ticker}`;

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
  await s.fillSelector(sel(em), email); await s.wait(1);
  await s.fillSelector(sel(pw), password); await s.wait(1);
  const submitLoc = s.page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submitLoc.count()) await submitLoc.click().catch(() => {});
  else await s.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(() => {});
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

const PAGES = [
  'overview', 'chart', 'options-charting',
  'flow-overview', 'flow-alerts', 'options-flow-history', 'net-premium', 'nope',
  'greeks', 'greek-exposure',
  'option-chains', 'open-interest-changes', 'volatility',
  'darkpool',
  'insiders', 'institutions', 'shorts',
  'analysts', 'earnings', 'dividends', 'financials',
  'risk', 'seasonality', 'stock-talk',
];

async function inventoryPage(sess, urlPath) {
  const url = `https://unusualwhales.com/stock/${ticker}/${urlPath}`;
  console.error(`[inv] ${urlPath}: navigating`);
  await sess.goto(url);
  let len = 0;
  for (let i = 0; i < 30; i++) {
    len = await sess.page.evaluate('document.body?.innerText?.length || 0').catch(() => 0);
    if (len > 500) break;
    await sess.wait(1);
  }
  await sess.wait(4); // let charts settle
  const info = await sess.page.evaluate(`(() => {
    const pick = (el) => ({
      text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      role: el.getAttribute('role'),
      tag: el.tagName,
    });
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const tabs = Array.from(document.querySelectorAll('[role="tab"], [class*="tab" i], button'))
      .filter(visible)
      .map(pick)
      .filter(x => x.text && x.text.length > 0 && x.text.length < 40);
    const selects = Array.from(document.querySelectorAll('select')).map(sel => ({
      name: sel.name || sel.id || null,
      options: Array.from(sel.options).map(o => o.text.trim()).slice(0, 20),
    }));
    const charts = Array.from(document.querySelectorAll('svg, canvas'))
      .filter(visible)
      .map(c => {
        const r = c.getBoundingClientRect();
        return { tag: c.tagName, w: Math.round(r.width), h: Math.round(r.height) };
      })
      .filter(c => c.w > 80 && c.h > 80);
    const tables = Array.from(document.querySelectorAll('table')).map(t => ({
      headers: Array.from(t.querySelectorAll('thead th, thead td')).map(h => h.innerText.trim()).slice(0, 15),
      rowCount: t.querySelectorAll('tbody tr').length,
      firstRow: Array.from((t.querySelector('tbody tr')?.querySelectorAll('td, th') || []))
        .map(c => c.innerText.trim()).slice(0, 12),
    }));
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(visible)
      .map(i => ({
        type: i.type, name: i.name || null, placeholder: i.placeholder || null,
      }));
    return {
      finalUrl: location.pathname + location.search,
      title: document.title,
      bodyLen: (document.body?.innerText || '').length,
      has404: /page like that|not found/i.test(document.body?.innerText || ''),
      tabs: Array.from(new Map(tabs.map(t => [t.text, t])).values()),
      selects, charts, tables, inputs,
    };
  })()`).catch((e) => ({ err: e.message }));
  const pngDir = path.join(outDir, 'pages');
  fs.mkdirSync(pngDir, { recursive: true });
  const pngPath = path.join(pngDir, `${urlPath}.png`);
  await sess.page.screenshot({ path: pngPath, fullPage: true }).catch((e) => {
    console.error(`[inv] ${urlPath}: screenshot failed: ${e.message}`);
  });
  return { page: urlPath, url, screenshot: pngPath, ...info };
}

if (mode === 'inventory') {
  try {
    await login();
    await s.wait(3);
    fs.mkdirSync(outDir, { recursive: true });
    const invPath = path.join(outDir, 'inventory.json');
    const existing = fs.existsSync(invPath)
      ? JSON.parse(fs.readFileSync(invPath, 'utf8'))
      : { ticker, pages: [] };
    const done = new Set(existing.pages.filter(p => !p.err).map(p => p.page));
    let sess = s;
    let processed = 0;
    for (const p of PAGES) {
      if (done.has(p) && fs.existsSync(path.join(outDir, 'pages', `${p}.png`))) {
        console.error(`[inv] ${p}: skip (already done)`);
        continue;
      }
      if (fs.existsSync(path.join(outDir, 'pages', `${p}.png`)) && !done.has(p)) {
        // PNG exists but no inventory record — seed a minimal record
        existing.pages.push({ page: p, seeded: true });
        done.add(p);
        console.error(`[inv] ${p}: skip (screenshot found, seeding record)`);
        continue;
      }
      // Restart browser every 4 pages to avoid memory bloat / crashes
      if (processed > 0 && processed % 4 === 0) {
        console.error(`[inv] restarting browser after ${processed} pages`);
        await sess.close().catch(() => {});
        sess = await WSession.start({ label: `uw_probe_${ticker}_b${processed}`, proxy: process.env.PROXY_URL || 'oxylabs' });
        // Re-login in new session
        const orig = s; // eslint-disable-line no-unused-vars
        globalThis.__s = sess;
        await (async () => {
          await sess.goto('https://unusualwhales.com/login');
          for (let i = 0; i < 30; i++) {
            const c = await sess.page.evaluate('document.querySelectorAll("input").length').catch(() => 0);
            if (c >= 2) break;
            await sess.wait(1);
          }
          const inputs = await sess.page.evaluate(`(() => Array.from(document.querySelectorAll('input')).map(i => ({ name: i.name, type: i.type, ph: i.placeholder })))()`);
          const em = inputs.find(i => i.type === 'email' || i.name === 'email' || /email|address/i.test(i.ph || ''));
          const pw = inputs.find(i => i.type === 'password' || i.name === 'password');
          const buildSel = (i) => i.name ? `input[name="${i.name}"]` : `input[placeholder="${i.ph}"]`;
          await sess.fillSelector(buildSel(em), email); await sess.wait(1);
          await sess.fillSelector(buildSel(pw), password); await sess.wait(1);
          const submitLoc = sess.page.locator('button[type="submit"], input[type="submit"]').first();
          if (await submitLoc.count()) await submitLoc.click().catch(() => {});
          else await sess.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(() => {});
          for (let i = 0; i < 30; i++) { await sess.wait(2); if (!sess.page.url().includes('/login')) return; }
          throw new Error('relogin failed');
        })();
        await sess.wait(3);
      }
      const r = await inventoryPage(sess, p).catch((e) => ({ page: p, err: e.message }));
      existing.pages.push(r);
      fs.writeFileSync(invPath, JSON.stringify(existing, null, 2));
      const charts = (r.charts || []).length;
      const tabs = (r.tabs || []).length;
      const tables = (r.tables || []).length;
      console.error(`[inv] ${p}: bodyLen=${r.bodyLen} has404=${r.has404} tabs=${tabs} charts=${charts} tables=${tables}`);
      processed++;
    }
    process.stdout.write(JSON.stringify(existing, null, 2) + '\n');
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  } finally {
    await (globalThis.__s || s).close().catch(() => {});
    process.exit(0);
  }
} else {
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
}
