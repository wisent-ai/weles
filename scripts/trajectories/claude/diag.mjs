// Shared page-state capture for the claude login trajectory's three
// failure paths (overall watchdog, codePromise deadline, google-button
// miss). Each await is individually error-guarded so a closed/navigating
// page still yields a usable string instead of throwing over the real
// failure. Keeps the captured-field set identical across all three so
// blobs from different stall points are directly comparable.
export async function pageDiag(page, { html = false } = {}) {
  const u = await Promise.resolve(page.url()).catch((x) => `url-err:${x.message}`);
  const t = await page.title().catch((x) => `title-err:${x.message}`);
  let content;
  if (html) {
    content = await page.content()
      .then((h) => h.replace(/\s+/g, ' ').slice(0, 2500))
      .catch((x) => `html-err:${x.message}`);
  } else {
    content = await page.locator('body').innerText()
      .then((b) => b.replace(/\s+/g, ' ').slice(0, 800))
      .catch((x) => `body-err:${x.message}`);
  }
  const key = html ? 'html' : 'bodyText';
  const con = Array.isArray(globalThis.__claudeConsole) ? globalThis.__claudeConsole.slice(-12) : [];
  return `url=${u} title=${JSON.stringify(t)} console=${JSON.stringify(con)} ${key}=${JSON.stringify(content)}`;
}

// Process-wide watchdog. MUST exit even if diagnostics hang — the page can
// be wedged in exactly the way that makes CDP title/content calls never
// return, so a hard secondary timer guarantees a blob is written. The
// outer timer is intentionally NOT unref'd: it must keep the event loop
// alive so it actually fires when the main flow is blocked in an await.
export function startWatchdog(getPage, getStep, sec) {
  return setTimeout(() => {
    const hard = setTimeout(() => {
      console.log(`FAIL: overall watchdog ${sec}s at step=${getStep()} (diag hung, hard exit)`);
      process.exit(1);
    }, 15000);
    hard.unref();
    pageDiag(getPage())
      .then((d) => console.log(`FAIL: overall watchdog ${sec}s exceeded at step=${getStep()} ${d}`))
      .catch((e) => console.log(`FAIL: overall watchdog ${sec}s at step=${getStep()} diag-error:${e.message}`))
      .finally(() => process.exit(1));
  }, sec * 1000);
}
