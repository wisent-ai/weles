// Shared Playwright page-measurement helpers for weles inspect tooling
// (viewport.mjs single-URL inspector + test-apps.mjs product runner). Pure
// functions over a Playwright `page` — no CLI, no browser launch here.

// Load a URL and wait for layout to settle: the 'load' event, then resolve
// once documentElement.scrollWidth holds steady across consecutive frames.
// Best-effort: returns {settled:true} or {settled:false, reason} (the caller
// still measures the current state rather than aborting).
export async function gotoSettled(page, url) {
  await page.goto(url, { waitUntil: 'load' }); // allow-raw-playwright: own apps, no anti-bot
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
    })); // allow-raw-playwright: own apps
  } catch (e) {
    return { settled: false, reason: e.message };
  }
  return { settled: true };
}

// Measure viewport overflow + render state. Returns a metrics object with
// the authoritative horizontal-cutoff signal (scrollWidth > innerWidth) plus
// an offender list of the elements crossing the viewport's right edge.
export async function measurePage(page) {
  return page.evaluate(() => {
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
}

// Classify a page from its metrics. NO_CONTENT_RENDERED guards against a
// false OK on a blank / auth-gated render.
export function cutoffVerdict(m) {
  if (m.elementCount < 5 || m.bodyTextLen === 0) return 'NO_CONTENT_RENDERED';
  return m.hasHorizontalScroll ? 'CUT_OFF_HORIZONTAL' : 'OK_NO_HORIZONTAL_CUTOFF';
}
