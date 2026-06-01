// weles viewport / layout-cutoff inspector. Loads a URL in a fixed-size
// headless Chromium viewport and reports whether the page is "cut off" —
// i.e. its content overflows the viewport horizontally (the usual symptom:
// content clipped past the right edge / a horizontal scrollbar). Authoritative
// signal is document scrollWidth > window.innerWidth; an offender list of the
// DOM elements crossing the right edge is captured for diagnosis. Saves a
// viewport-clipped screenshot (what the user actually sees) and a full-page
// screenshot (what's hidden) plus a JSON summary.
//
// Usage:
//   node scripts/inspect/viewport.mjs [--url <url>] [--width 1280] [--height 800] [--label trading]
//
// Default URL: https://app.wisent.com/assistants/trading — our own app, no
// anti-bot, so raw Playwright is used directly. Waits are event-based.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
  // App may hold ws/SSE open so 'networkidle' can hang — wait on 'load'.
  await page.goto(URL, { waitUntil: 'load' }); // allow-raw-playwright: own app, no anti-bot
  // Settle client render: resolve once scrollWidth holds steady across frames.
  // Best-effort — if it never converges, log and measure the current state.
  try {
    await page.waitForFunction(() => new Promise((res) => {
      let last = -1; let stable = 0;
      const tick = () => {
        const w = document.documentElement.scrollWidth;
        if (w !== last) { last = w; stable = 0; requestAnimationFrame(tick); return; }
        stable += 1;
        if (stable >= 4) { res(true); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })); // allow-raw-playwright: own app
  } catch (e) {
    console.error(`[viewport] settle wait did not converge (${e.message}); measuring current state`);
  }

  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const vw = window.innerWidth; const vh = window.innerHeight;
    const sw = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
    const sh = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const off = [];
    for (const el of document.querySelectorAll('body *')) {
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const overRight = r.right - vw;
      if (overRight > 1) {
        const cls = (el.className && el.className.toString) ? el.className.toString() : '';
        off.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: cls.slice(0, 60),
          right: Math.round(r.right),
          left: Math.round(r.left),
          width: Math.round(r.width),
          overRight: Math.round(overRight),
        });
      }
    }
    off.sort((a, b) => b.overRight - a.overRight);
    const bodyText = document.body ? document.body.innerText.trim() : '';
    return {
      url: location.href,
      title: document.title,
      vw, vh, sw, sh,
      horizOverflowPx: sw - vw,
      vertOverflowPx: sh - vh,
      hasHorizontalScroll: sw - vw > 1,
      elementCount: document.body ? document.body.querySelectorAll('*').length : 0,
      bodyTextLen: bodyText.length,
      bodyTextHead: bodyText.slice(0, 600),
      offenderCount: off.length,
      offenders: off.slice(0, 15),
    };
  });

  await page.screenshot({ path: join(OUT, `${LABEL}_viewport_${ts}.png`), fullPage: false }); // allow-raw-playwright: own app
  await page.screenshot({ path: join(OUT, `${LABEL}_fullpage_${ts}.png`), fullPage: true }); // allow-raw-playwright: own app

  // A blank/near-empty render means there is nothing to assess — do NOT
  // report OK in that case (it would be a false pass).
  const noContent = m.elementCount < 5 || m.bodyTextLen === 0;
  const verdict = noContent
    ? 'NO_CONTENT_RENDERED'
    : (m.hasHorizontalScroll ? 'CUT_OFF_HORIZONTAL' : 'OK_NO_HORIZONTAL_CUTOFF');
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
