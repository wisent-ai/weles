// Hide automation signals before any page code runs.

// navigator.webdriver
Object.defineProperty(Navigator.prototype, 'webdriver', {
  get: () => undefined,
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

// Make toString() of overridden functions look native
const _origToString = Function.prototype.toString;
const _nativeOverrides = new Set();

Function.prototype.toString = function() {
  if (_nativeOverrides.has(this)) {
    return 'function ' + (this.name || '') + '() { [native code] }';
  }
  return _origToString.call(this);
};
_nativeOverrides.add(Function.prototype.toString);

// Helper to define a property that looks native
window.__welesDefine = function(obj, prop, getter) {
  _nativeOverrides.add(getter);
  Object.defineProperty(obj, prop, {
    get: getter,
    configurable: true,
    enumerable: true,
  });
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

  // 2. navigator.plugins — Chrome PDF plugins
  const _pluginData = [
    { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer',
      mimeTypes: [{ type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }] },
    { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
      mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf', description: '' }] },
    { name: 'Native Client', description: '', filename: 'internal-nacl-plugin',
      mimeTypes: [
        { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
        { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
      ] },
  ];

  // Build realistic Plugin objects
  function _makePlugin(data) {
    const p = {};
    Object.defineProperties(p, {
      name: { value: data.name, enumerable: true },
      description: { value: data.description, enumerable: true },
      filename: { value: data.filename, enumerable: true },
      length: { value: data.mimeTypes.length, enumerable: true },
    });
    data.mimeTypes.forEach(function(mt, i) {
      const mimeObj = {};
      Object.defineProperties(mimeObj, {
        type: { value: mt.type, enumerable: true },
        suffixes: { value: mt.suffixes, enumerable: true },
        description: { value: mt.description, enumerable: true },
        enabledPlugin: { value: p, enumerable: true },
      });
      Object.defineProperty(p, i, { value: mimeObj, enumerable: false });
    });
    p.item = function(i) { return p[i]; };
    p.namedItem = function(name) { for (var j = 0; j < data.mimeTypes.length; j++) if (p[j] && p[j].type === name) return p[j]; return null; };
    p[Symbol.iterator] = function*() { for (var j = 0; j < data.mimeTypes.length; j++) yield p[j]; };
    return p;
  }

  const _plugins = _pluginData.map(_makePlugin);
  _plugins.item = function(i) { return _plugins[i]; };
  _plugins.namedItem = function(name) { return _plugins.find(function(p) { return p.name === name; }) || null; };
  _plugins.refresh = function() {};

  window.__welesDefine(Navigator.prototype, 'plugins', function() { return _plugins; });

  // 3. navigator.mimeTypes — matching mimeTypes for plugins
  const _allMimes = [];
  _pluginData.forEach(function(pd) {
    pd.mimeTypes.forEach(function(mt) {
      const mimeObj = {};
      Object.defineProperties(mimeObj, {
        type: { value: mt.type, enumerable: true },
        suffixes: { value: mt.suffixes, enumerable: true },
        description: { value: mt.description, enumerable: true },
      });
      _allMimes.push(mimeObj);
    });
  });
  _allMimes.item = function(i) { return _allMimes[i]; };
  _allMimes.namedItem = function(name) { return _allMimes.find(function(m) { return m.type === name; }) || null; };

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
  if (!navigator.connection) {
    window.__welesDefine(Navigator.prototype, 'connection', function() {
      return {
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
        onchange: null,
        addEventListener: function() {},
        removeEventListener: function() {},
      };
    });
  }

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
