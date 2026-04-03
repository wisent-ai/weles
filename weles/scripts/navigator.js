// Override navigator properties from __weles.navigator config.

if (__weles.navigator) {
  const nav = __weles.navigator;
  const define = window.__welesDefine;

  const props = [
    'userAgent', 'appVersion', 'platform', 'vendor', 'product',
    'productSub', 'language', 'hardwareConcurrency', 'maxTouchPoints',
    'doNotTrack', 'oscpu', 'buildID',
  ];

  for (const prop of props) {
    if (nav[prop] !== undefined) {
      const val = nav[prop];
      define(Navigator.prototype, prop, function() { return val; });
    }
  }

  // Languages needs to return a frozen array
  if (nav.languages) {
    const langs = Object.freeze([...nav.languages]);
    define(Navigator.prototype, 'languages', function() { return langs; });
  }

  // deviceMemory (Firefox doesn't normally expose it, only set if configured)
  if (nav.deviceMemory !== undefined && nav.deviceMemory !== null) {
    const dm = nav.deviceMemory;
    define(Navigator.prototype, 'deviceMemory', function() { return dm; });
  }

  // pdfViewerEnabled
  if (nav.pdfViewerEnabled !== undefined) {
    const pv = nav.pdfViewerEnabled;
    define(Navigator.prototype, 'pdfViewerEnabled', function() { return pv; });
  }
}

// --- Screen and window dimensions ---
if (__weles.screen) {
  const scr = __weles.screen;
  const define = window.__welesDefine;
  for (const [prop, val] of Object.entries(scr)) {
    if (val !== undefined) {
      define(Screen.prototype, prop, function() { return val; });
    }
  }
}
if (__weles.window) {
  const win = __weles.window;
  const define = window.__welesDefine;
  for (const prop of ['outerWidth', 'outerHeight', 'screenX', 'screenY', 'devicePixelRatio']) {
    if (win[prop] !== undefined) {
      const val = win[prop];
      define(window, prop, function() { return val; });
    }
  }
}

// --- Timezone ---
if (__weles.timezone && __weles.timezone.offset !== undefined) {
  const offset = __weles.timezone.offset;
  Date.prototype.getTimezoneOffset = function() { return offset; };
}
