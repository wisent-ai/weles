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
