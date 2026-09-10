// Firefox-specific init-script masks. Runs only when the weles fingerprint
// config resolves browser='firefox' (loader.ts decides).
//
// Paired with chrome147_stubs.js: that file fills the Chromium-145-vs-real-
// Chrome-147 API gap on the weles custom Chromium binary. This file does the
// OPPOSITE direction of the same problem — ensures Playwright-managed Firefox
// doesn't carry Chrome-only globals that real Firefox lacks, and scrubs the
// few Playwright-juggler markers that survive addInitScript injection.

(function installFirefoxStubs() {
  try {
    // 1. Defensively remove Chrome-only globals that real Firefox does not
    //    expose. A UA-says-Firefox session carrying these would flag any
    //    bot classifier that cross-checks UA against visible API surfaces.
    for (const name of ['Sanitizer', 'AnimationTrigger', 'TimelineTrigger', 'TimelineTriggerRange']) {
      try { if (name in window) delete window[name]; } catch (_) {}
      try { Object.defineProperty(window, name, { value: undefined, configurable: true }); } catch (_) {}
    }

    // 2. If the config supplied Firefox-expected navigator surfaces (oscpu,
    //    buildID), assert them on Navigator.prototype so code reading the
    //    prototype directly sees the spoofed value. navigator.js already
    //    sets them via `define(Navigator.prototype, ...)` when present in
    //    config; this is a safety net for when it wasn't.
    if (typeof __weles !== 'undefined' && __weles.navigator) {
      const nav = __weles.navigator;
      if (nav.oscpu && typeof navigator.oscpu === 'undefined') {
        try {
          Object.defineProperty(Navigator.prototype, 'oscpu', { get() { return nav.oscpu; }, configurable: true });
        } catch (_) {}
      }
      if (nav.buildID && typeof navigator.buildID === 'undefined') {
        try {
          Object.defineProperty(Navigator.prototype, 'buildID', { get() { return nav.buildID; }, configurable: true });
        } catch (_) {}
      }
    }

    // 3. Scrub juggler detection surface. Playwright's Firefox fork can
    //    surface __playwright_* or _playwright_* markers on window; delete
    //    defensively. Matches the spirit of the chromium-side identifier
    //    rename (memory 2026-04-20: renamed __playwright_global_listeners_check__
    //    in injectedScriptSource.js).
    for (const key of Object.keys(window)) {
      if (typeof key === 'string' && (key.indexOf('__playwright') === 0 || key.indexOf('_playwright_') === 0)) {
        try { delete window[key]; } catch (_) {}
      }
    }
  } catch (_) {
    // Swallow — init scripts must not throw or the whole chain stops.
  }
})();
