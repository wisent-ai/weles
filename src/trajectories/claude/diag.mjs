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

// recordVideo only finalizes a non-empty .webm when the browser context
// is closed. process.exit() bypasses `finally`, so every exit path must
// close the session first or the video is 0 bytes (useless — the only
// sanctioned diagnostic). makeShutdown returns a shutdown(code) that
// flushes the session (bounded so a hung close can't wedge the VM) then
// exits. getSession returns the live WSession or null.
export function makeShutdown(getSession) {
  return async function shutdown(code) {
    const s = getSession();
    if (s) {
      const flushed = s.close().then(() => true);
      const capped = new Promise((r) => setTimeout(() => r(false), 20000));
      const ok = await Promise.race([flushed, capped]);
      if (!ok) console.error('session close did not finish before cap');
    }
    process.exit(code);
  };
}

// Process-wide watchdog. MUST exit even if diagnostics hang — the page
// can be wedged so CDP title/content never return; a hard secondary
// timer guarantees termination. Not unref'd: keeps the loop alive so it
// fires while the main flow is blocked in an await. onTimeout flushes
// the video before exit.
export function startWatchdog(getPage, getStep, sec, shutdown) {
  return setTimeout(() => {
    const hard = setTimeout(() => {
      console.log(`FAIL: overall watchdog ${sec}s at step=${getStep()} (diag hung, hard exit)`);
      shutdown(1);
    }, 25000);
    hard.unref();
    pageDiag(getPage())
      .then((d) => console.log(`FAIL: overall watchdog ${sec}s exceeded at step=${getStep()} ${d}`))
      .catch((e) => console.log(`FAIL: overall watchdog ${sec}s at step=${getStep()} diag-error:${e.message}`))
      .finally(() => shutdown(1));
  }, sec * 1000);
}
