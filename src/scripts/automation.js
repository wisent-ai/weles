// Hide automation signals before any page code runs.

// navigator.webdriver — return false (not undefined) to match real Chrome
Object.defineProperty(Navigator.prototype, 'webdriver', {
  get: () => false,
  configurable: true,
});

// Playwright/Puppeteer/Selenium markers
for (const prop of [
  '__webdriver_script_fn', '__webdriver_evaluate', '__selenium_evaluate',
  '__fxdriver_evaluate', '__driver_unwrapped', '__webdriver_unwrapped',
  '__driver_evaluate', '__fxdriver_unwrapped', '__lastWatirAlert',
  '__lastWatirConfirm', '__lastWatirPrompt', 'domAutomation',
  'domAutomationController', '_phantom', 'callPhantom', '__nightmare',
  '_selenium', 'cdc_adoQpoasnfa76pfcZLmcfl_Array',
  'cdc_adoQpoasnfa76pfcZLmcfl_Promise', 'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
]) {
  try { delete window[prop]; } catch(e) {}
  try {
    Object.defineProperty(window, prop, {
      get: () => undefined,
      configurable: true,
    });
  } catch(e) {}
}

// Make toString() of overridden functions look native. Critical: real
// Chrome emits "function get innerHeight() { [native code] }" for window
// getters (with "get " prefix and accessor name), but the prior version
// emitted "function innerHeight() { [native code] }" (no prefix). PX
// fingerprints walk Object.getOwnPropertyDescriptor(window,'innerHeight')
// .get.toString() and the missing prefix flags us as tampered (cited
// .work/inst/linkedin_login_diff_2026-05-04T03-31-04-140Z.md Function
// .toString inspections section: "get innerHeight" et al only fire on
// weles after PX flags us → it then runs the deep probes).
const _origToString = Function.prototype.toString;
const _nativeStrings = new Map();
const _nativeOverrides = new Set();

Function.prototype.toString = function() {
  const exact = _nativeStrings.get(this);
  if (exact !== undefined) return exact;
  if (_nativeOverrides.has(this)) {
    return 'function ' + (this.name || '') + '() { [native code] }';
  }
  return _origToString.call(this);
};
// Self-register the toString patch so PX's
// Function.prototype.toString.toString() returns Chrome's exact output.
_nativeStrings.set(Function.prototype.toString, 'function toString() { [native code] }');

// Helper to define a getter property that looks native. kind defaults to
// 'get' (Chrome accessor format); pass 'method' for method overrides
// (e.g. getBattery) which don't have the "get " prefix.
window.__welesDefine = function(obj, prop, getter, kind) {
  const k = kind || 'get';
  const fakeStr = k === 'get'
    ? 'function get ' + prop + '() { [native code] }'
    : 'function ' + prop + '() { [native code] }';
  _nativeStrings.set(getter, fakeStr);
  Object.defineProperty(obj, prop, {
    get: getter,
    configurable: true,
    enumerable: true,
  });
};

// Register exact toString output for non-getter overrides (Date.prototype
// .getTimezoneOffset, Intl.DateTimeFormat.prototype.resolvedOptions, etc).
window.__welesNativeString = function(fn, name) {
  _nativeStrings.set(fn, 'function ' + name + '() { [native code] }');
};

// --- Chromium-specific anti-detection ---
if (__weles.browser === 'chromium') {

  // 1. window.chrome — make it look like a real Chrome browser
  //    Only set up if not already present (don't break real extensions).
  if (!window.chrome || !window.chrome.runtime || !window.chrome.runtime.id) {
    const chrome = window.chrome || {};
    chrome.runtime = chrome.runtime || {
      // Provide ProgrammaticError to look authentic
      ProgrammaticError: class ProgrammaticError extends Error {},
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
      connect: function() { return { onMessage: { addListener: function(){} }, postMessage: function(){}, disconnect: function(){} }; },
      sendMessage: function() {},
      id: undefined,
    };
    chrome.loadTimes = chrome.loadTimes || function() {
      return {
        commitLoadTime: Date.now() / 1000,
        connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000 - 0.3,
        startLoadTime: Date.now() / 1000 - 0.2,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      };
    };
    chrome.csi = chrome.csi || function() {
      return { onloadT: Date.now(), startE: Date.now() - 300, pageT: 300, tran: 15 };
    };
    _nativeOverrides.add(chrome.loadTimes);
    _nativeOverrides.add(chrome.csi);
    if (chrome.runtime.connect) _nativeOverrides.add(chrome.runtime.connect);
    if (chrome.runtime.sendMessage) _nativeOverrides.add(chrome.runtime.sendMessage);
    window.chrome = chrome;
  }

  // 2. navigator.plugins — Chrome 147 ships 5 PDF-viewer plugin entries (no
  // Native Client). Names + their mimeTypes set are aligned with navigator.js's
  // patchPlugins so both code paths produce consistent counts on PerimeterX
  // serialization.
  const _PDF_PLUGIN_NAMES = 'PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF'.split(',');
  const _PDF_MTS = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'text/pdf',        suffixes: 'pdf', description: 'Portable Document Format' },
  ];
  const _pluginData = _PDF_PLUGIN_NAMES.map(function(n) {
    return { name: n, description: 'Portable Document Format', filename: 'internal-pdf-viewer', mimeTypes: _PDF_MTS };
  });

  // Build realistic Plugin objects. Real Chrome's Plugin instances expose
  // name/description/filename/length on Plugin.prototype (non-enumerable).
  // JSON.stringify on a real plugin gives {"0":{}, "1":{}} — only the indexed
  // MimeType references show, and even those serialize empty because MimeType
  // properties are also non-enumerable. Diff'd 2026-04-25 vs Chrome 147 on PX
  // iframe: weles plugins were serializing with full metadata inline.
  function _makePlugin(data) {
    const p = {};
    Object.defineProperties(p, {
      name: { value: data.name, enumerable: false },
      description: { value: data.description, enumerable: false },
      filename: { value: data.filename, enumerable: false },
      length: { value: data.mimeTypes.length, enumerable: false },
    });
    data.mimeTypes.forEach(function(mt, i) {
      const mimeObj = {};
      Object.defineProperties(mimeObj, {
        type: { value: mt.type, enumerable: false },
        suffixes: { value: mt.suffixes, enumerable: false },
        description: { value: mt.description, enumerable: false },
        enabledPlugin: { value: p, enumerable: false },
      });
      Object.defineProperty(p, i, { value: mimeObj, enumerable: true });
    });
    Object.defineProperty(p, 'item', { value: function(i) { return p[i]; }, enumerable: false });
    Object.defineProperty(p, 'namedItem', { value: function(name) { for (var j = 0; j < data.mimeTypes.length; j++) if (p[j] && p[j].type === name) return p[j]; return null; }, enumerable: false });
    Object.defineProperty(p, Symbol.iterator, { value: function*() { for (var j = 0; j < data.mimeTypes.length; j++) yield p[j]; }, enumerable: false });
    return p;
  }

  // Real Chrome's navigator.plugins is a PluginArray (host object), not a JS Array.
  // JSON.stringify on a PluginArray produces {"0":..., "1":..., ..., "refresh":fn}
  // (an object with numeric-string keys), not [...] (an array). Pre-fix weles used
  // _pluginData.map → real Array → serialized as [...]. Now wrap as a plain object
  // with numeric-keyed plugins as enumerable + length+item/namedItem/refresh as non-
  // enumerable, matching chrome's PluginArray serialization shape.
  const _plugins = {};
  _pluginData.forEach(function(pd, i) {
    Object.defineProperty(_plugins, i, { value: _makePlugin(pd), enumerable: true });
  });
  Object.defineProperty(_plugins, 'length', { value: _pluginData.length, enumerable: false });
  Object.defineProperty(_plugins, 'item', { value: function(i) { return _plugins[i]; }, enumerable: false });
  Object.defineProperty(_plugins, 'namedItem', { value: function(name) { for (var j = 0; j < _pluginData.length; j++) if (_plugins[j] && _plugins[j].name === name) return _plugins[j]; return null; }, enumerable: false });
  Object.defineProperty(_plugins, 'refresh', { value: function() {}, enumerable: false });

  window.__welesDefine(Navigator.prototype, 'plugins', function() { return _plugins; });

  // 3. navigator.mimeTypes — DEDUPED across plugins. Real Chrome only lists
  // each unique mime type once even when multiple plugins claim the same one
  // (5 PDF-viewer plugins all share application/pdf + text/pdf → mimeTypes
  // has 2 entries, not 10). Dedupe by .type.
  const _allMimes = {};
  let _mimeIdx = 0;
  const _seenMimes = {};
  _pluginData.forEach(function(pd) {
    pd.mimeTypes.forEach(function(mt) {
      if (_seenMimes[mt.type]) return;
      _seenMimes[mt.type] = true;
      const mimeObj = {};
      Object.defineProperties(mimeObj, {
        type: { value: mt.type, enumerable: false },
        suffixes: { value: mt.suffixes, enumerable: false },
        description: { value: mt.description, enumerable: false },
      });
      Object.defineProperty(_allMimes, _mimeIdx++, { value: mimeObj, enumerable: true });
    });
  });
  Object.defineProperty(_allMimes, 'length', { value: _mimeIdx, enumerable: false });
  Object.defineProperty(_allMimes, 'item', { value: function(i) { return _allMimes[i]; }, enumerable: false });
  Object.defineProperty(_allMimes, 'namedItem', { value: function(name) { for (var j = 0; j < _mimeIdx; j++) if (_allMimes[j] && _allMimes[j].type === name) return _allMimes[j]; return null; }, enumerable: false });

  window.__welesDefine(Navigator.prototype, 'mimeTypes', function() { return _allMimes; });

  // 4. Permissions API — realistic notification permission response
  if (window.navigator.permissions) {
    const _origPermQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = function(params) {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission || 'prompt', onchange: null });
      }
      return _origPermQuery(params);
    };
    _nativeOverrides.add(window.navigator.permissions.query);
  }

  // 5. navigator.connection — NetworkInformation API
  // Real Chrome on macOS exposes a NetworkInformation INSTANCE whose properties
  // are getter-defined on NetworkInformation.prototype, not own enumerable.
  // JSON.stringify on the instance returns '{}'. PerimeterX's li.protechts.net
  // iframe reads via JSON.stringify and previously saw weles emit the OVERRIDE
  // values — fingerprint tell.
  // Now: ALWAYS install the override (don't skip if native exists, because
  // weles' native NetworkInformation may already be shape-leaking own
  // enumerable properties). The override returns an empty-shape object whose
  // values are accessible via direct access but invisible to JSON.stringify.
  window.__welesDefine(Navigator.prototype, 'connection', function() {
    const conn = Object.create(null);
    const define = function(k, v) { Object.defineProperty(conn, k, { value: v, enumerable: false, configurable: true, writable: false }); };
    define('effectiveType', '4g');
    define('rtt', 50);
    define('downlink', 10);
    define('saveData', false);
    define('onchange', null);
    define('addEventListener', function() {});
    define('removeEventListener', function() {});
    return conn;
  });

  // 6. navigator.getBattery — battery API
  if (!navigator.getBattery) {
    Navigator.prototype.getBattery = function() {
      return Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1,
        addEventListener: function() {},
        removeEventListener: function() {},
        onchargingchange: null,
        onchargingtimechange: null,
        ondischargingtimechange: null,
        onlevelchange: null,
      });
    };
    _nativeOverrides.add(Navigator.prototype.getBattery);
  }
}
