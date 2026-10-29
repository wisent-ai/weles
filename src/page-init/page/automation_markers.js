// Hide automation signals before any page code runs, and install the native
// toString registry every later init script reports its overrides through
// (__welesDefine, __welesNativeString). The loader concatenates the page-init
// scripts into one script, so automation.js and the navigator scripts after it
// see the declarations made here.

// Firefox is skipped: the weles-patched Firefox binary already forces
// navigator.webdriver=false NATIVELY (dom.webdriver.enabled:false +
// weles.fingerprint.webdriver.force prefs). Layering a JS `() => false`
// getter on top makes
// Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get
// .toString() return "() => false" instead of Firefox's native
// "function webdriver() { [native code] }" — the exact signal Google's
// "this browser or app may not be secure" botguard reads. The Selenium/cdc_
// marker scrub is Chromium/Selenium-oriented too; defining getters for those
// names on Firefox would make `name in window` true for props real Firefox
// never has. Juggler markers are scrubbed in firefox/stubs.js instead.
if (__weles.browser !== 'firefox') {
  // navigator.webdriver — return false (not undefined) to match real Chrome
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: () => false,
    configurable: true,
  });

  // Playwright/Puppeteer/Selenium markers
  for (const prop of [
    '__webdriver_script_fn',
    '__webdriver_evaluate',
    '__selenium_evaluate',
    '__fxdriver_evaluate',
    '__driver_unwrapped',
    '__webdriver_unwrapped',
    '__driver_evaluate',
    '__fxdriver_unwrapped',
    '__lastWatirAlert',
    '__lastWatirConfirm',
    '__lastWatirPrompt',
    'domAutomation',
    'domAutomationController',
    '_phantom',
    'callPhantom',
    '__nightmare',
    '_selenium',
    'cdc_adoQpoasnfa76pfcZLmcfl_Array',
    'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
    'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
  ]) {
    try {
      delete window[prop];
    } catch (e) {}
    try {
      Object.defineProperty(window, prop, {
        get: () => undefined,
        configurable: true,
      });
    } catch (e) {}
  }
}

// Preserve native-style function descriptions, including the get prefix and
// accessor name for overridden getters.
const _origToString = Function.prototype.toString;
const _nativeStrings = new Map();
var _nativeOverrides = new Set();

Function.prototype.toString = function () {
  const exact = _nativeStrings.get(this);
  if (exact !== undefined) return exact;
  if (_nativeOverrides.has(this)) {
    return 'function ' + (this.name || '') + '() { [native code] }';
  }
  return _origToString.call(this);
};
// Self-register the toString patch so PX's
// Function.prototype.toString.toString() returns Chrome's exact output.
_nativeStrings.set(
  Function.prototype.toString,
  'function toString() { [native code] }',
);

// Helper to define a getter property that looks native. kind defaults to
// 'get' (Chrome accessor format); pass 'method' for method overrides
// (e.g. getBattery) which don't have the "get " prefix.
window.__welesDefine = function (obj, prop, getter, kind) {
  const k = kind || 'get';
  const fakeStr =
    k === 'get'
      ? 'function get ' + prop + '() { [native code] }'
      : 'function ' + prop + '() { [native code] }';
  _nativeStrings.set(getter, fakeStr);
  try {
    Object.defineProperty(obj, prop, {
      get: getter,
      configurable: true,
      enumerable: true,
    });
  } catch (e) {
    // Custom Chromium may already expose a non-configurable native getter for
    // this property (e.g. navigator.webdriver set by the C++ fingerprint).
    // Swallow the conflict so the rest of the init script keeps running.
  }
};

// Register exact toString output for non-getter overrides (Date.prototype
// .getTimezoneOffset, Intl.DateTimeFormat.prototype.resolvedOptions, etc).
window.__welesNativeString = function (fn, name) {
  _nativeStrings.set(fn, 'function ' + name + '() { [native code] }');
};
