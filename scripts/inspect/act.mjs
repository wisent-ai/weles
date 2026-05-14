// One-shot helper: attach to keep_session.mjs's persistent browser via CDP,
// perform a single action against the front page, detach without closing.
//
// Usage:
//   node act.mjs dump                                       (writes outerHTML + JSON summary to .work/inspect/)
//   node act.mjs click '<selector>'
//   node act.mjs fill '<selector>' '<text>'
//   node act.mjs nav '<url>'
//   node act.mjs screenshot
//   node act.mjs eval '<js expression>'
//   node act.mjs url
//   node act.mjs api <METHOD> <path> [body]                 (same-origin fetch with cookies; writes response to .work/inspect/)
//   node act.mjs download <url> <out_path>                  (fetch+save bytes via page context — for large files use curl directly)
//
// Default port 9223. Override with --port N.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx >= 0 ? Number(argv[portIdx + 1]) : 9223;
if (portIdx >= 0) argv.splice(portIdx, 2);
const CDP = `http://localhost:${PORT}`;
const OUT = '.work/inspect';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const [action, ...args] = argv;
if (!action) { console.error('usage: act.mjs <action> [args]'); process.exit(1); }

const browser = await chromium.connectOverCDP(CDP).catch((e) => { console.error(`CDP attach failed: ${e.message}`); process.exit(2); });
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];
console.log(`[act] attached. URL: ${page.url()}`);

const ts = new Date().toISOString().replace(/[:.]/g, '-');

if (action === 'dump') {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  const fp = join(OUT, `dump_${ts}.html`);
  writeFileSync(fp, html);
  const summary = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(e => e.offsetParent).map(e => ({ tag: e.tagName, type: e.type, name: e.name, placeholder: e.placeholder || '', value: (e.value || '').slice(0, 40), classes: e.className?.slice(0, 80) }));
    const buttons = Array.from(document.querySelectorAll('button, a, [role=button]')).filter(e => e.offsetParent).map(e => ({ tag: e.tagName, text: (e.innerText || '').trim().slice(0, 80), href: e.href || '', classes: e.className?.slice(0, 80) })).filter(o => o.text || o.classes);
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, w: f.offsetWidth, h: f.offsetHeight }));
    const modals = Array.from(document.querySelectorAll('[class*="modal" i], [class*="dialog" i], [class*="drawer" i], [role="dialog"]')).filter(e => e.offsetParent).map(e => ({ tag: e.tagName, classes: e.className?.slice(0, 100), text: (e.innerText || '').slice(0, 200) }));
    return { url: location.href, title: document.title, inputs, buttons: buttons.slice(0, 30), iframes, modals };
  });
  const sp = join(OUT, `summary_${ts}.json`);
  writeFileSync(sp, JSON.stringify(summary, null, 2));
  console.log(`[act] dump html=${fp} summary=${sp}`);
  console.log(`[act] iframes: ${JSON.stringify(summary.iframes)}`);
  console.log(`[act] modals: ${summary.modals.length} | inputs: ${summary.inputs.length} | buttons: ${summary.buttons.length}`);
} else if (action === 'click') {
  const sel = args.join(' ');
  await page.locator(sel).filter({ visible: true }).first().click();
  console.log(`[act] clicked: ${sel}`);
} else if (action === 'fill') {
  const sel = args[0]; const text = args.slice(1).join(' ');
  await page.locator(sel).filter({ visible: true }).first().fill(text);
  console.log(`[act] filled '${sel}'`);
} else if (action === 'nav') {
  await page.goto(args[0], { waitUntil: 'domcontentloaded' });
  console.log(`[act] navigated to ${page.url()}`);
} else if (action === 'screenshot') {
  const fp = join(OUT, `shot_${ts}.png`);
  await page.screenshot({ path: fp, fullPage: false });
  console.log(`[act] screenshot ${fp}`);
} else if (action === 'eval') {
  const js = args.join(' ');
  const r = await page.evaluate(js);
  console.log(`[act] eval result: ${JSON.stringify(r)?.slice(0, 500)}`);
} else if (action === 'url') {
  console.log(`[act] url: ${page.url()}`);
} else if (action === 'watch') {
  const durSec = Number(args[0] || 10);
  const filterRx = args[1] ? new RegExp(args[1], 'i') : /unity|kharma|assetstore/i;
  const requests = [];
  page.on('request', req => {
    requests.push({ method: req.method(), url: req.url(), resourceType: req.resourceType(), postData: req.postData()?.slice(0, 4000) || '', ts: Date.now() });
  });
  page.on('response', async res => {
    const r = requests.find(x => x.url === res.url() && !x.status);
    if (!r) return;
    r.status = res.status();
    if (filterRx.test(r.url) && r.resourceType !== 'image' && r.resourceType !== 'font' && r.resourceType !== 'stylesheet') {
      try { r.body = (await res.text()).slice(0, 8000); } catch(e) { r.body = `<read failed: ${e.message}>`; }
    }
  });
  console.log(`[act] watch ${durSec}s filter=${filterRx} — drive the browser now in a separate act invocation`);
  await new Promise(r => setTimeout(r, durSec * 1000));  // allow-raw-playwright: review — context-dependent timer
  const interesting = requests.filter(r => filterRx.test(r.url) && r.resourceType !== 'image' && r.resourceType !== 'font' && r.resourceType !== 'stylesheet');
  const fp = join(OUT, `watch_${ts}.json`);
  writeFileSync(fp, JSON.stringify(interesting, null, 2));
  console.log(`[act] watch ${interesting.length} relevant requests, ${requests.length} total → ${fp}`);
} else if (action === 'api') {
  const method = args[0]; const path = args[1]; const body = args.slice(2).join(' ') || '';
  const result = await page.evaluate(async ({method, path, body}) => {
    const headers = { 'Content-Type': 'application/json' };
    // Include NextAuth CSRF token if present (sent on POST endpoints that
    // do double-submit verification, e.g. /api/graphql on assetstore).
    const csrfMatch = document.cookie.match(/(?:__Host-next-auth\.csrf-token|__Host-authjs\.csrf-token)=([^;]+)/);
    if (csrfMatch) {
      const v = decodeURIComponent(csrfMatch[1]).split('|')[0];
      headers['x-csrf-token'] = v;
      headers['x-xsrf-token'] = v;
    }
    const opts = { method, credentials: 'include', headers };
    if (body) opts.body = body;
    const r = await fetch(path, opts);
    return { status: r.status, body: await r.text() };
  }, { method, path, body });
  const fp = join(OUT, `api_${ts}.json`);
  writeFileSync(fp, result.body);
  console.log(`[act] api ${method} ${path} -> status=${result.status} bytes=${result.body.length} file=${fp}`);
} else if (action === 'download') {
  const url = args[0]; const outPath = args.slice(1).join(' ');
  // Stream via Node fetch (page.evaluate would OOM on large GLBs).
  const r = await fetch(url);
  if (!r.ok) { console.log(`[act] download HTTP ${r.status}`); process.exit(3); }
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(outPath, buf);
  console.log(`[act] download ${url} -> ${outPath} (${buf.length} bytes)`);
} else {
  console.error(`[act] unknown action: ${action}`);
  process.exit(1);
}

await browser.close();
