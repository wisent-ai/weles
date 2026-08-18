// weles viewport / layout-cutoff inspector for a SINGLE url. Loads a URL in a
// fixed headless Chromium viewport and reports whether content overflows the
// viewport horizontally (the cut-off symptom: content clipped past the right
// edge / a horizontal scrollbar). For testing many products at once use
// scripts/inspect/apps/run.mjs, which reuses the same measurement lib.
//
// Usage:
//   node scripts/inspect/viewport.mjs [--url <url>] [--width 1280] [--height 800] [--label trading]
//
// Default URL: https://app.wisent.com/assistants/trading — our own app, no
// anti-bot, so raw Playwright is used directly. Waits are event-based.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gotoSettled, measurePage, cutoffVerdict } from './lib/page-checks.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const URL = opt('--url', 'https://app.wisent.com/assistants/trading');
const WIDTH = Number(opt('--width', '1280'));
const HEIGHT = Number(opt('--height', '800'));
const LABEL = opt('--label', 'trading');
const OUT = '.work/inspect/viewport';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
let exitCode = 0;
try {
  const s = await gotoSettled(page, URL);
  if (!s.settled) console.error(`[viewport] settle did not converge (${s.reason}); measuring current state`);
  const m = await measurePage(page);

  await page.screenshot({ path: join(OUT, `${LABEL}_viewport_${ts}.png`), fullPage: false }); // allow-raw-playwright: own app
  await page.screenshot({ path: join(OUT, `${LABEL}_fullpage_${ts}.png`), fullPage: true }); // allow-raw-playwright: own app

  const verdict = cutoffVerdict(m);
  const result = {
    verdict,
    viewport: `${WIDTH}x${HEIGHT}`,
    ...m,
    screenshots: { viewport: `${LABEL}_viewport_${ts}.png`, fullPage: `${LABEL}_fullpage_${ts}.png` },
  };
  writeFileSync(join(OUT, `${LABEL}_${ts}.json`), JSON.stringify(result, null, 2));

  console.log(`[viewport] url=${m.url}`);
  console.log(`[viewport] title=${JSON.stringify(m.title)}`);
  console.log(`[viewport] viewport=${WIDTH}x${HEIGHT}  content=${m.sw}x${m.sh}  elements=${m.elementCount}  bodyTextLen=${m.bodyTextLen}`);
  console.log(`[viewport] bodyTextHead=${JSON.stringify(m.bodyTextHead)}`);
  console.log(`[viewport] horizOverflow=${m.horizOverflowPx}px  vertOverflow=${m.vertOverflowPx}px`);
  console.log(`[viewport] VERDICT=${verdict}  (elements crossing right edge=${m.offenderCount})`);
  for (const o of m.offenders.slice(0, 8)) {
    console.log(`[viewport]   +${o.overRight}px  <${o.tag}${o.id ? '#' + o.id : ''} class="${o.cls}">  right=${o.right} width=${o.width}`);
  }
  console.log(`[viewport] wrote ${LABEL}_viewport_${ts}.png ${LABEL}_fullpage_${ts}.png ${LABEL}_${ts}.json -> ${OUT}`);
} catch (e) {
  console.error(`[viewport] FAILED: ${e.message}`);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exitCode = exitCode;
