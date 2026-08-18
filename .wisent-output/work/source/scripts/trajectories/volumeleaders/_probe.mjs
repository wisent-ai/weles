// Discover volumeleaders.com URL structure after login.
// Default mode: logs in, dumps every <a href> on the dashboard and /ticker/TICKER pages.
// Inventory mode: walks a list of candidate per-ticker pages, screenshots + records DOM.
// Usage: node scripts/trajectories/volumeleaders/_probe.mjs --ticker ORCL
//        node scripts/trajectories/volumeleaders/_probe.mjs --mode inventory --ticker ORCL

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
const outDir = args['out-dir'] || `/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/trading-tools/screenshots/VL_${ticker}`;

const email = process.env.VL_EMAIL;
const password = process.env.VL_PASSWORD;
if (!email || !password) { console.error('FAIL: VL creds not set'); process.exit(1); }

const s = await WSession.start({ label: `vl_probe_${ticker}`, proxy: process.env.PROXY_URL || 'oxylabs' });

async function login() {
  console.error('[vl] logging in');
  await s.goto('https://www.volumeleaders.com/Login');
  // Wait for form fields to appear.
  for (let i = 0; i < 30; i++) {
    const ok = await s.page.evaluate('document.querySelector("input[name=Email]") && document.querySelector("input[name=Password]")').catch(() => false);
    if (ok) break;
    await s.wait(1);
  }
  const fill = (sel, val) => s.page.evaluate(`(({ sel, val }) => { const el = document.querySelector(sel); if (!el) return false; el.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })(${JSON.stringify({ sel, val })})`);
  await fill('input[name="Email"]', email); await s.wait(1);
  await fill('input[name="Password"]', password); await s.wait(1);
  // Shared-atom submit with form.requestSubmit as a secondary path
  const submitLoc = s.page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submitLoc.count()) await submitLoc.click().catch(() => {});
  else await s.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(() => {});
  // Wait for redirect away from /Login
  for (let i = 0; i < 30; i++) {
    await s.wait(2);
    const u = s.page.url();
    if (!u.toLowerCase().includes('/login')) { console.error(`[vl] logged in, at ${u}`); return; }
    // Look for error message
    const err = await s.page.evaluate(`(() => document.querySelector('.field-validation-error, .alert-danger, [class*="error"]')?.innerText || null)()`).catch(() => null);
    if (err) console.error(`[vl] error: ${err.slice(0, 200)}`);
  }
  throw new Error('login did not redirect');
}

async function collectLinks() {
  return await s.page.evaluate(`(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('/') && !href.startsWith('https://www.volumeleaders.com') && !href.startsWith('https://volumeleaders.com')) continue;
      const path = href.replace(/^https:\\/\\/(www\\.)?volumeleaders\\.com/, '');
      if (!path || path === '/' || path.startsWith('#')) continue;
      const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().slice(0, 80);
      out.push({ path, text });
    }
    return out;
  })()`);
}

// Filled in from the dashboard sidebar after login.
let TICKER_PAGES = [];

async function probePage(urlPath) {
  const url = urlPath.startsWith('http') ? urlPath : `https://www.volumeleaders.com${urlPath}`;
  await s.goto(url);
  let len = 0;
  for (let i = 0; i < 20; i++) {
    len = await s.page.evaluate('document.body?.innerText?.length || 0').catch(() => 0);
    if (len > 500) break;
    await s.wait(1);
  }
  await s.wait(3);
  return await s.page.evaluate(`(() => ({
    finalUrl: location.pathname + location.search,
    title: document.title,
    bodyLen: (document.body?.innerText || '').length,
    has404: /page not found|404|doesn.t exist/i.test(document.body?.innerText || ''),
    hasLogin: /please log in|sign in|log in/i.test(document.body?.innerText || '') && !/logout|sign out/i.test(document.body?.innerText || ''),
    heading: document.querySelector('h1, h2')?.innerText?.trim() || null,
  }))()`).catch((e) => ({ err: e.message }));
}

async function inventoryPage(sess, urlPath) {
  const url = urlPath.startsWith('http') ? urlPath : `https://www.volumeleaders.com${urlPath}`;
  console.error(`[inv] ${urlPath}: navigating`);
  await sess.goto(url);
  let len = 0;
  for (let i = 0; i < 30; i++) {
    len = await sess.page.evaluate('document.body?.innerText?.length || 0').catch(() => 0);
    if (len > 500) break;
    await sess.wait(1);
  }
  await sess.wait(4);
  const info = await sess.page.evaluate(`(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const tabs = Array.from(document.querySelectorAll('[role="tab"], [class*="tab"], .nav-link, button'))
      .filter(visible)
      .map(e => (e.innerText || '').trim().slice(0, 40))
      .filter(t => t && t.length > 0);
    const selects = Array.from(document.querySelectorAll('select')).map(sel => ({
      name: sel.name || sel.id || null,
      options: Array.from(sel.options).map(o => o.text.trim()).slice(0, 20),
    }));
    const charts = Array.from(document.querySelectorAll('svg, canvas'))
      .filter(visible)
      .map(c => { const r = c.getBoundingClientRect(); return { tag: c.tagName, w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter(c => c.w > 80 && c.h > 80);
    const tables = Array.from(document.querySelectorAll('table')).map(t => ({
      headers: Array.from(t.querySelectorAll('thead th, thead td')).map(h => h.innerText.trim()).slice(0, 15),
      rowCount: t.querySelectorAll('tbody tr').length,
      firstRow: Array.from((t.querySelector('tbody tr')?.querySelectorAll('td, th') || []))
        .map(c => c.innerText.trim()).slice(0, 12),
    }));
    return {
      finalUrl: location.pathname + location.search,
      title: document.title,
      bodyLen: (document.body?.innerText || '').length,
      tabs: Array.from(new Set(tabs)),
      selects, charts, tables,
    };
  })()`).catch((e) => ({ err: e.message }));
  const pngDir = path.join(outDir, 'pages');
  fs.mkdirSync(pngDir, { recursive: true });
  const fname = urlPath.replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '') + '.png';
  const pngPath = path.join(pngDir, fname);
  await sess.page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  return { page: urlPath, url, screenshot: pngPath, ...info };
}

try {
  await login();
  await s.wait(3);

  if (mode === 'inventory') {
    fs.mkdirSync(outDir, { recursive: true });
    const results = [];
    for (const p of TICKER_PAGES) {
      try {
        const r = await inventoryPage(s, p);
        results.push(r);
        const tabs = (r.tabs || []).length;
        const tables = (r.tables || []).length;
        const charts = (r.charts || []).length;
        console.error(`[inv] ${p}: bodyLen=${r.bodyLen} tabs=${tabs} charts=${charts} tables=${tables} title=${JSON.stringify(r.title)}`);
      } catch (e) {
        console.error(`[inv] ${p}: ERROR ${e.message}`);
        results.push({ page: p, err: e.message });
      }
    }
    process.stdout.write(JSON.stringify({ ticker, pages: results }, null, 2) + '\n');
  } else {
    // Screenshot the dashboard + inspect interactive elements
    const dashDir = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/trading-tools/screenshots/VL_dashboard';
    fs.mkdirSync(dashDir, { recursive: true });
    // Wait for full JS load
    await s.page.evaluate('document.readyState === "complete"').catch(() => {});
    await s.wait(5);
    await s.page.screenshot({ path: path.join(dashDir, 'executive_summary.png'), fullPage: true }).catch(() => {});
    const diag = await s.page.evaluate(`(() => ({
      url: location.href,
      title: document.title,
      bodyLen: (document.body?.innerText || '').length,
      bodyFirst500: (document.body?.innerText || '').slice(0, 500),
      aCount: document.querySelectorAll('a').length,
      aHrefCount: document.querySelectorAll('a[href]').length,
      buttonCount: document.querySelectorAll('button').length,
      iframeCount: document.querySelectorAll('iframe').length,
      navHtml: (document.querySelector('nav, [class*="sidebar" i], [class*="navbar" i], [class*="menu" i]')?.innerHTML || '').slice(0, 2000),
      topButtonLabels: Array.from(document.querySelectorAll('button, [role="button"], [role="link"], [onclick]'))
        .map(e => (e.innerText || e.getAttribute('aria-label') || '').trim())
        .filter(t => t && t.length > 0 && t.length < 60)
        .slice(0, 40),
    }))()`).catch(e => ({ err: e.message }));
    console.error('[vl] dashboard diag: ' + JSON.stringify(diag).slice(0, 800));
    fs.writeFileSync(path.join(dashDir, 'executive_summary_diag.json'), JSON.stringify(diag, null, 2));

    const dashboardLinks = await collectLinks();
    console.error(`[vl] dashboard: ${dashboardLinks.length} links`);

    // For each distinct top-level path, collect its links too (one nav level deep)
    const seenTop = new Set();
    const deepLinks = new Map();
    for (const l of dashboardLinks) {
      const top = l.path.split('?')[0].split('/').filter(Boolean)[0] || '';
      if (!top || seenTop.has(top)) continue;
      seenTop.add(top);
      try {
        await s.goto(`https://www.volumeleaders.com${l.path}`);
        await s.wait(3);
        const subLinks = await collectLinks();
        for (const sl of subLinks) {
          if (!deepLinks.has(sl.path)) deepLinks.set(sl.path, sl.text);
        }
        console.error(`[vl] ${l.path}: +${subLinks.length} links`);
      } catch (e) {
        console.error(`[vl] ${l.path}: ERROR ${e.message}`);
      }
    }

    const all = new Map();
    for (const l of dashboardLinks) if (!all.has(l.path)) all.set(l.path, l.text);
    for (const [p, t] of deepLinks) if (!all.has(p)) all.set(p, t);

    // Bucket by top-level segment
    const buckets = {};
    for (const [p, t] of all.entries()) {
      const top = p.split('?')[0].split('/').filter(Boolean)[0] || '';
      if (!buckets[top]) buckets[top] = [];
      buckets[top].push({ path: p, text: t });
    }

    process.stdout.write(JSON.stringify({
      ticker,
      totalLinks: all.size,
      buckets,
      links: Array.from(all.entries()).map(([p, t]) => ({ path: p, text: t })),
    }, null, 2) + '\n');
  }
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
