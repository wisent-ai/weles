// weles testing mode — smoke-test Wisent apps/products in headless Chromium.
// For each registered target: load it, capture console + page errors, measure
// viewport overflow and render state, screenshot it, and assert it (a) renders
// content, (b) has no horizontal cutoff, (c) logged no errors. Auth-gated
// targets with no session are reported SKIPPED_NEEDS_SESSION (not failed).
// Writes a JSON report and exits non-zero if any target FAILS, so it can gate
// a deploy.
//
// Usage:
//   node scripts/inspect/apps/run.mjs [--only name1,name2] [--viewport 1280x800]
//        [--storage <playwright-storage-state.json>]   # auth session for gated routes
//
// Our own apps, no anti-bot — raw Playwright is used directly.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TARGETS } from './targets.mjs';
import { gotoSettled, measurePage, cutoffVerdict } from '../lib/page-checks.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const only = opt('--only', '');
const vpOverride = opt('--viewport', '');
const storagePath = opt('--storage', '');
const OUT = '.work/inspect/test-apps';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');

const onlySet = only ? new Set(only.split(',').map((s) => s.trim())) : null;
const targets = TARGETS.filter((t) => !onlySet || onlySet.has(t.name));
if (targets.length === 0) {
  console.error(`[test-apps] no targets matched --only=${only}`);
  process.exit(2);
}
if (storagePath && !existsSync(storagePath)) {
  console.error(`[test-apps] --storage file not found: ${storagePath}`);
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const results = [];
for (const t of targets) {
  const dims = (vpOverride || `${t.viewport[0]}x${t.viewport[1]}`).split('x').map(Number);
  const ctxOpts = { viewport: { width: dims[0], height: dims[1] }, deviceScaleFactor: 1 };
  if (storagePath) ctxOpts.storageState = storagePath;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${(e.message || String(e)).slice(0, 200)}`));

  let rec;
  try {
    const s = await gotoSettled(page, t.url);
    const m = await measurePage(page);
    const shot = `${t.name}_${ts}.png`;
    await page.screenshot({ path: join(OUT, shot), fullPage: false }); // allow-raw-playwright: own apps
    const cutoff = cutoffVerdict(m);
    const rendered = m.elementCount >= (t.expectMinElements || 5) && m.bodyTextLen > 0;
    let status;
    if (!rendered && t.requiresAuth && !storagePath) status = 'SKIPPED_NEEDS_SESSION';
    else if (!rendered) status = 'FAIL_NO_CONTENT';
    else if (cutoff === 'CUT_OFF_HORIZONTAL') status = 'FAIL_CUT_OFF';
    else if (errors.length > 0) status = 'FAIL_CONSOLE_ERRORS';
    else status = 'PASS';
    rec = {
      name: t.name, url: t.url, viewport: `${dims[0]}x${dims[1]}`, status,
      settled: s.settled, finalUrl: m.url, title: m.title,
      elements: m.elementCount, bodyTextLen: m.bodyTextLen,
      horizOverflowPx: m.horizOverflowPx, offenders: m.offenders.slice(0, 5),
      consoleErrors: errors.slice(0, 5), screenshot: shot,
    };
  } catch (e) {
    rec = { name: t.name, url: t.url, status: 'FAIL_ERROR', error: e.message };
  }
  results.push(rec);
  const el = rec.elements === undefined ? '-' : rec.elements;
  const ov = rec.horizOverflowPx === undefined ? '-' : `${rec.horizOverflowPx}px`;
  const er = rec.consoleErrors ? rec.consoleErrors.length : '-';
  console.log(`[test-apps] ${rec.status.padEnd(20)} ${t.name.padEnd(13)} ${t.url}  (el=${el} hOverflow=${ov} errs=${er})`);
  await context.close();
}
await browser.close();

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status.startsWith('FAIL')).length;
const skipped = results.filter((r) => r.status.startsWith('SKIPPED')).length;
const summary = { ts, total: results.length, pass, fail, skipped, results };
writeFileSync(join(OUT, `report_${ts}.json`), JSON.stringify(summary, null, 2));
console.log(`[test-apps] SUMMARY pass=${pass} fail=${fail} skipped=${skipped}  report -> ${OUT}/report_${ts}.json`);
process.exitCode = fail > 0 ? 1 : 0;
