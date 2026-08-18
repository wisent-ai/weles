// One-shot helper: attach to keeper.mjs's persistent browser via CDP,
// perform a single action, detach without closing.
//
// Usage:
//   node action.mjs dump
//   node action.mjs click 'button:has-text("Send")'
//   node action.mjs fill 'input[type="email"]' 'lukasz@example.com'
//   node action.mjs nav https://example.com
//   node action.mjs screenshot
//   node action.mjs eval 'document.title'

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';

const CDP = 'http://localhost:9223';
const OUT = '.work/keeper';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const [, , action, ...args] = process.argv;
if (!action) { console.error('usage: action.mjs <action> [args]'); process.exit(1); }

const browser = await chromium.connectOverCDP(CDP).catch((e) => { console.error(`CDP attach failed: ${e.message}`); process.exit(2); });
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];
console.log(`[action] attached. URL: ${page.url()}`);

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
  console.log(`[action] dump html=${fp} summary=${sp}`);
  console.log(`[action] iframes: ${JSON.stringify(summary.iframes)}`);
  console.log(`[action] modals: ${summary.modals.length}`);
  console.log(`[action] inputs: ${summary.inputs.length}, buttons: ${summary.buttons.length}`);
} else if (action === 'click') {
  const sel = args.join(' ');
  const loc = page.locator(sel).filter({ visible: true }).first();
  await humanClickLocator(page, loc);
  console.log(`[action] clicked: ${sel}`);
} else if (action === 'fill') {
  const sel = args[0]; const text = args.slice(1).join(' ');
  const loc = page.locator(sel).filter({ visible: true }).first();
  await humanFill(page, loc, text);
  console.log(`[action] filled '${sel}' with '${text}'`);
} else if (action === 'nav') {
  await page.goto(args[0], { waitUntil: 'domcontentloaded' });
  console.log(`[action] navigated to ${page.url()}`);
} else if (action === 'screenshot') {
  const fp = join(OUT, `shot_${ts}.png`);
  // canvas.toDataURL bypasses Playwright's font/animation stability wait which
  // times out on rAF pages, AND nested CDP sessions which hang under
  // connectOverCDP. Works only for pages with a single visible canvas.
  const dataUrl = await page.evaluate(() => {
    if (typeof window.__renderForShot === 'function') window.__renderForShot();
    const cv = document.querySelector('canvas');
    return cv ? cv.toDataURL('image/png') : null;
  });
  if (!dataUrl) { console.log('[action] no canvas on page'); }
  else {
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    writeFileSync(fp, Buffer.from(b64, 'base64'));
    console.log(`[action] screenshot ${fp} (${Buffer.from(b64, 'base64').length} bytes)`);
  }
} else if (action === 'eval') {
  const js = args.join(' ');
  const r = await page.evaluate(js);
  console.log(`[action] eval result: ${JSON.stringify(r)?.slice(0, 500)}`);
} else if (action === 'url') {
  console.log(`[action] url: ${page.url()}`);
} else if (action === 'api') {
  // api <METHOD> <path> [body] — call same-origin API with the page's cookies
  const method = args[0]; const path = args[1]; const body = args.slice(2).join(' ') || '';
  const result = await page.evaluate(async ({method, path, body}) => {
    const opts = { method, credentials: 'include', headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = body;
    const r = await fetch(path, opts);
    return { status: r.status, body: await r.text() };
  }, { method, path, body });
  const fp = join(OUT, `api_${ts}.json`);
  writeFileSync(fp, result.body);
  console.log(`[action] api ${method} ${path} -> status=${result.status} bytes=${result.body.length} file=${fp}`);
} else if (action === 'download') {
  // download <url> <out_path> — fetch a URL via page.evaluate and save bytes
  const url = args[0]; const outPath = args.slice(1).join(' ');
  const data = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    const buf = await r.arrayBuffer();
    return { status: r.status, b64: btoa(String.fromCharCode(...new Uint8Array(buf))) };
  }, url);
  if (data.status === 200 && data.b64) {
    const buf = Buffer.from(data.b64, 'base64');
    writeFileSync(outPath, buf);
    console.log(`[action] download ${url} -> ${outPath} (${buf.length} bytes)`);
  } else {
    console.log(`[action] download FAIL status=${data.status}`);
  }
} else {
  console.error(`[action] unknown: ${action}`);
}

// Detach without closing
await browser.close();
