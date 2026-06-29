// weles testing mode — smoke-test Wisent apps/products in headless Chromium.
// For each registered target: load it, capture console + page errors, measure
// viewport overflow and render state, screenshot it, record a short video, and
// assert it (a) renders content, (b) has no horizontal cutoff, (c) logged no
// errors. Auth-gated targets with no session are reported SKIPPED_NEEDS_SESSION
// (not failed). Writes JSON + Markdown reports and exits non-zero if any target
// FAILS, so it can gate a deploy.
//
// Usage:
//   node scripts/inspect/apps/run.mjs [--only name1,name2] [--viewport 1280x800]
//        [--storage <playwright-storage-state.json>]   # auth session for gated routes
//
// Our own apps, no anti-bot — raw Playwright is used directly.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { TARGETS } from './targets.mjs';
import { gotoSettled, measurePage, cutoffVerdict } from '../lib/page-checks.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const only = opt('--only', '');
const vpOverride = opt('--viewport', '');
const storagePath = opt('--storage', '');
const click = opt('--click', ''); // optional: click a button/tab by its text before measuring
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
  const ctxOpts = {
    viewport: { width: dims[0], height: dims[1] },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: { width: dims[0], height: dims[1] } },
  };
  if (storagePath) ctxOpts.storageState = storagePath;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  const video = page.video();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${(e.message || String(e)).slice(0, 200)}`));

  let rec;
  try {
    const s = await gotoSettled(page, t.url);
    if (click) {
      try {
        await page.getByRole('button', { name: click, exact: false }).first().click(); // allow-raw-playwright: own apps
        // Let React commit + paint the new tab (two frames, no fixed timeout).
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // allow-raw-playwright: own apps
      } catch (e) {
        console.error(`[test-apps] ${t.name}: --click "${click}" failed: ${e.message}`);
      }
    }
    const m = await measurePage(page);
    const shot = `${t.name}_${ts}.png`;
    await page.screenshot({ path: join(OUT, shot), fullPage: false }); // allow-raw-playwright: own apps
    const cutoff = cutoffVerdict(m);
    const rendered = m.elementCount >= (t.expectMinElements || 5) && m.bodyTextLen > 0;
    const auditText = `${m.title}\n${m.bodyTextHead || ''}`.toLowerCase();
    const auditSignals = {
      mentionsTrial: /\b(free trial|trial|try free|start free)\b/i.test(auditText),
      mentionsPricing: /\b(pricing|price|plan|subscription|subscribe|billing)\b/i.test(auditText),
      mentionsInstall: /\b(install|download|app store|testflight|pwa)\b/i.test(auditText),
      mentionsLogin: /\b(sign in|log in|login|continue with|create account)\b/i.test(auditText),
      mentionsEmotion: /\b(love|feel|lonely|friend|companion|memory|dream|confidence|private)\b/i.test(auditText),
    };
    let status;
    if (!rendered && t.requiresAuth && !storagePath) status = 'SKIPPED_NEEDS_SESSION';
    else if (!rendered) status = 'FAIL_NO_CONTENT';
    else if (cutoff === 'CUT_OFF_HORIZONTAL') status = 'FAIL_CUT_OFF';
    else if (errors.length > 0) status = 'FAIL_CONSOLE_ERRORS';
    else status = 'PASS';
    rec = {
      name: t.name, product: t.product || t.name, kind: t.kind || 'unknown',
      url: t.url, viewport: `${dims[0]}x${dims[1]}`, status,
      settled: s.settled, finalUrl: m.url, title: m.title,
      elements: m.elementCount, bodyTextLen: m.bodyTextLen,
      horizOverflowPx: m.horizOverflowPx, offenders: m.offenders.slice(0, 5),
      consoleErrors: errors.slice(0, 5), screenshot: shot, auditSignals,
    };
  } catch (e) {
    rec = { name: t.name, product: t.product || t.name, kind: t.kind || 'unknown', url: t.url, status: 'FAIL_ERROR', error: e.message };
  }
  await context.close();
  if (video) {
    try {
      const rawVideo = await video.path();
      const videoName = `${t.name}_${ts}.webm`;
      renameSync(rawVideo, join(OUT, videoName));
      rec.video = videoName;
    } catch (e) {
      rec.videoError = e.message;
    }
  }
  results.push(rec);
  const el = rec.elements === undefined ? '-' : rec.elements;
  const ov = rec.horizOverflowPx === undefined ? '-' : `${rec.horizOverflowPx}px`;
  const er = rec.consoleErrors ? rec.consoleErrors.length : '-';
  console.log(`[test-apps] ${rec.status.padEnd(20)} ${t.name.padEnd(21)} ${t.url}  (el=${el} hOverflow=${ov} errs=${er})`);
}
await browser.close();

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status.startsWith('FAIL')).length;
const skipped = results.filter((r) => r.status.startsWith('SKIPPED')).length;
const productCount = new Set(results.map((r) => r.product)).size;
const summary = { ts, total: results.length, productCount, pass, fail, skipped, results };
const jsonReport = `report_${ts}.json`;
const mdReport = `report_${ts}.md`;
writeFileSync(join(OUT, jsonReport), JSON.stringify(summary, null, 2));

const md = [
  `# Wisent Product Surface Audit`,
  ``,
  `Generated: ${ts}`,
  ``,
  `Products: ${productCount}`,
  `Surfaces: ${results.length}`,
  `Pass: ${pass}`,
  `Fail: ${fail}`,
  `Skipped: ${skipped}`,
  ``,
  `## Criteria`,
  ``,
  `- Renders meaningful content`,
  `- No horizontal cutoff at the audited viewport`,
  `- No browser console/page errors`,
  `- Captures screenshot and video evidence`,
  `- Flags surface-level signals for trial, pricing, install, login, and emotional copy`,
  ``,
  `## Results`,
  ``,
  `| Status | Product | Surface | Kind | URL | Screenshot | Video | Signals |`,
  `|---|---|---|---|---|---|---|---|`,
  ...results.map((r) => {
    const signals = r.auditSignals
      ? Object.entries(r.auditSignals).filter(([, v]) => v).map(([k]) => k.replace(/^mentions/, '')).join(', ')
      : '';
    return `| ${r.status} | ${r.product} | ${r.name} | ${r.kind} | ${r.url} | ${r.screenshot || ''} | ${r.video || ''} | ${signals} |`;
  }),
  ``,
].join('\n');
writeFileSync(join(OUT, mdReport), md);

console.log(`[test-apps] SUMMARY products=${productCount} surfaces=${results.length} pass=${pass} fail=${fail} skipped=${skipped}`);
console.log(`[test-apps] reports -> ${OUT}/${jsonReport} ${OUT}/${mdReport}`);
process.exitCode = fail > 0 ? 1 : 0;
