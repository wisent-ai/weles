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

  // userAgentData — spoof brands to include Google Chrome
  if (nav.userAgent && navigator.userAgentData) {
    const versionMatch = nav.userAgent.match(/Chrome\/(\d+)/);
    if (versionMatch) {
      const majorVersion = versionMatch[1];
      const fullVersion = (nav.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || majorVersion + '.0.0.0';
      // Real Chrome 147's deterministic grease produces 'Not.A/Brand' (period+slash).
      // Diff'd 2026-04-25 vs Chrome 147 on M2 Mac on linkedin.com/login PerimeterX
      // iframe — chrome=Not.A/Brand, weles=Not/A)Brand. Pre-fix the seeded variants
      // table (3 grease shapes) didn't include the Not.A/Brand variant at all.
      const seed = parseInt(majorVersion) % 4;
      const greaseyBrands = [
        {brand: 'Not.A/Brand', version: '8'},
        {brand: 'Not/A)Brand', version: '8'},
        {brand: 'Not A;Brand', version: '99'},
        {brand: 'Not_A Brand', version: '8'},
      ];
      // Chrome 147 → seed 3 with %4, but the empirical value is Not.A/Brand (idx 0).
      // Hardcode v147 → idx 0 to match observed real-Chrome output.
      const greasey = parseInt(majorVersion) === 147 ? greaseyBrands[0] : greaseyBrands[seed];
      // Order must match real Chrome's navigator.userAgentData.brands:
      // [Google Chrome, Not.A/Brand-variant, Chromium]. Measured 2026-04-18
      // side-by-side with stock Chrome 147 on same Mac — Google Chrome is
      // index 0, not index 2. TikTok's webmssdk reads brands[0].brand and
      // signs it into x-mssdk-info; if brands[0] != "Google Chrome" the
      // signature identifies the session as non-Chrome.
      const brands = [
        {brand: 'Google Chrome', version: majorVersion},
        greasey,
        {brand: 'Chromium', version: majorVersion},
      ];
      const fullBrands = [
        {brand: 'Google Chrome', version: fullVersion},
        {brand: greasey.brand, version: greasey.version + '.0.0.0'},
        {brand: 'Chromium', version: fullVersion},
      ];
      // userAgentData.platform is the OS name (macOS/Windows/Linux), NOT navigator.platform
      // (which is MacIntel/Win32/Linux x86_64). Diff'd 2026-04-25: weles emitted
      // 'MacIntel' as userAgentData.platform — wrong field — vs real Chrome 'macOS'.
      // Map navigator.platform → OS name so PerimeterX sees consistent values.
      const platformMap = { MacIntel: 'macOS', Win32: 'Windows', 'Linux x86_64': 'Linux' };
      const platform = platformMap[nav.platform] || nav.platform || navigator.userAgentData.platform || '';
      const mobile = navigator.userAgentData.mobile || false;

      const uaData = {
        brands: Object.freeze(brands.map(function(b) { return Object.freeze(b); })),
        mobile: mobile,
        platform: platform,
        getHighEntropyValues: function(hints) {
          return Promise.resolve({
            brands: fullBrands.map(function(b) { return Object.freeze(b); }),
            fullVersionList: fullBrands.map(function(b) { return Object.freeze(b); }),
            mobile: mobile,
            platform: platform,
            platformVersion: nav.platformVersion || '',
            architecture: nav.architecture || 'arm',
            model: '',
            uaFullVersion: fullVersion,
          });
        },
        toJSON: function() {
          return { brands: brands, mobile: mobile, platform: platform };
        },
      };
      _nativeOverrides.add(uaData.getHighEntropyValues);
      _nativeOverrides.add(uaData.toJSON);
      define(Navigator.prototype, 'userAgentData', function() { return uaData; });
    }
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
  const winProps = 'outerWidth outerHeight screenX screenY devicePixelRatio'.split(' ');
  for (const prop of winProps) {
    if (win[prop] !== undefined) {
      const val = win[prop];
      define(window, prop, function() { return val; });
    }
  }
  // Also spoof innerWidth/innerHeight so outerH - innerH = sane toolbar height.
  // Without this, persona picks e.g. 2560x1600 (→ outerH = 1680) but the host Mac's
  // physical display clamps actual window to 982px, so real innerHeight stays 982
  // while spoofed outerHeight reports 1680. Inconsistent → fingerprint tell.
  if (win.innerWidth !== undefined) { const v = win.innerWidth; define(window, 'innerWidth', function() { return v; }); }
  else if (win.outerWidth !== undefined) { const v = win.outerWidth - 2; define(window, 'innerWidth', function() { return v; }); }
  if (win.innerHeight !== undefined) { const v = win.innerHeight; define(window, 'innerHeight', function() { return v; }); }
  else if (win.outerHeight !== undefined) { const v = win.outerHeight - 80; define(window, 'innerHeight', function() { return v; }); }
}

// --- Timezone ---
if (__weles.timezone && __weles.timezone.offset !== undefined) {
  const offset = __weles.timezone.offset;
  const tzFn = function() { return offset; };
  if (window.__welesNativeString) window.__welesNativeString(tzFn, 'getTimezoneOffset');
  Date.prototype.getTimezoneOffset = tzFn;
}

// --- navigator.plugins: include 'PDF Viewer' first ---
// PerimeterX bda diff (weles vs stock Chrome on linkedin.com/login) showed
// weles emits [Chrome PDF Viewer, Chromium PDF Viewer, ...]; real Chrome
// emits [PDF Viewer, Chrome PDF Viewer, Chromium PDF Viewer, ...]. PX serializes
// the plugin name list into the encrypted bda payload.
(function patchPlugins() {
  if (typeof navigator === 'undefined' || typeof Plugin === 'undefined' || typeof PluginArray === 'undefined') return;
  try {
    const mt0 = { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' };
    const mt1 = { type: 'text/pdf',        suffixes: 'pdf', description: 'Portable Document Format' };
    const names = 'PDF Viewer,Chrome PDF Viewer,Chromium PDF Viewer,Microsoft Edge PDF Viewer,WebKit built-in PDF'.split(',');
    const plugins = names.map(name => {
      const p = Object.create(Plugin.prototype);
      Object.defineProperties(p, { name: { value: name, enumerable: true }, filename: { value: 'internal-pdf-viewer', enumerable: true }, description: { value: 'Portable Document Format', enumerable: true }, length: { value: 2, enumerable: true }, '0': { value: mt0, enumerable: true }, '1': { value: mt1, enumerable: true } });
      return p;
    });
    const arr = Object.create(PluginArray.prototype);
    plugins.forEach((p, i) => Object.defineProperty(arr, i, { value: p, enumerable: true }));
    Object.defineProperty(arr, 'length', { value: plugins.length, enumerable: true });
    const pluginsGet = function() { return arr; };
    if (window.__welesNativeString) window.__welesNativeString(pluginsGet, 'get plugins');
    Object.defineProperty(navigator, 'plugins', { get: pluginsGet, configurable: true, enumerable: true });
  } catch { /* leave native */ }
})();

// --- navigator.connection downlink/effectiveType/rtt: realistic Chrome values ---
// PX networkInfo block: weles reports the host's throttled estimate (downlink<2,
// rtt 100-200); real Chrome on a normal connection reports downlink=10, rtt=50.
// Override BOTH the NetworkInformation instance AND its prototype because some
// code paths read getters off the instance directly (and because iframes get a
// fresh NetworkInformation that inherits from the same prototype).
(function patchConnection() {
  if (typeof navigator === 'undefined' || !navigator.connection) return;
  const apply = (target) => {
    const mk = (name, val) => { const g = function() { return val; }; if (window.__welesNativeString) window.__welesNativeString(g, 'get ' + name); return g; };
    try { Object.defineProperty(target, 'downlink',      { get: mk('downlink', 10),     configurable: true, enumerable: true }); } catch {}
    try { Object.defineProperty(target, 'effectiveType', { get: mk('effectiveType','4g'), configurable: true, enumerable: true }); } catch {}
    try { Object.defineProperty(target, 'rtt',           { get: mk('rtt', 50),          configurable: true, enumerable: true }); } catch {}
    try { Object.defineProperty(target, 'saveData',      { get: mk('saveData', false),  configurable: true, enumerable: true }); } catch {}
  };
  apply(navigator.connection);
  try { apply(Object.getPrototypeOf(navigator.connection)); } catch {}
  // NetworkInformation prototype reachable via constructor too.
  try { if (typeof NetworkInformation !== 'undefined') apply(NetworkInformation.prototype); } catch {}
})();

// --- navigator.bluetooth / navigator.keyboard stubs ---
// Real Chrome 147 exposes Web Bluetooth + Keyboard Lock APIs on navigator.
// weles' chromium-build may compile without them depending on build flags;
// PerimeterX checks 'bluetooth' in navigator and 'keyboard' in navigator and
// flags absence as bot. Expose minimal objects matching real-Chrome shape;
// the methods are getter-only and never called by PX (it just probes presence).
(function exposeBluetoothKeyboard() {
  if (typeof navigator === 'undefined') return;
  if (!('bluetooth' in navigator)) {
    const bluetooth = Object.create(null);
    Object.defineProperty(bluetooth, 'getAvailability', { value: function() { return Promise.resolve(false); }, configurable: false, enumerable: false });
    Object.defineProperty(bluetooth, 'requestDevice', { value: function() { return Promise.reject(new DOMException('Web Bluetooth API globally disabled.', 'NotFoundError')); }, configurable: false, enumerable: false });
    const btGet = function() { return bluetooth; };
    if (window.__welesNativeString) window.__welesNativeString(btGet, 'get bluetooth');
    Object.defineProperty(navigator, 'bluetooth', { get: btGet, configurable: true, enumerable: true });
  }
  if (!('keyboard' in navigator)) {
    const keyboard = Object.create(null);
    Object.defineProperty(keyboard, 'getLayoutMap', { value: function() { return Promise.resolve(new Map()); }, configurable: false, enumerable: false });
    Object.defineProperty(keyboard, 'lock', { value: function() { return Promise.resolve(undefined); }, configurable: false, enumerable: false });
    Object.defineProperty(keyboard, 'unlock', { value: function() { return undefined; }, configurable: false, enumerable: false });
    const kbGet = function() { return keyboard; };
    if (window.__welesNativeString) window.__welesNativeString(kbGet, 'get keyboard');
    Object.defineProperty(navigator, 'keyboard', { get: kbGet, configurable: true, enumerable: true });
  }
})();

// --- Intl locale ---
// Real Chrome's Intl.DateTimeFormat().resolvedOptions().locale ALWAYS matches
// navigator.language. ICU pulls from the same setting. weles can spoof
// navigator.language but Chromium's --lang flag doesn't always cascade to ICU
// (especially under xvfb-run on Linux, where the system locale leaks through).
// Force the locale to match navigator.language so PerimeterX/Akamai/DataDome
// don't see an en-US navigator with an en-GB Intl resolvedOptions.locale.
if (__weles.navigator && __weles.navigator.language) {
  const wantedLocale = __weles.navigator.language;
  const regNS = window.__welesNativeString;
  const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
  const dtf = function() { const r = orig.call(this); return { ...r, locale: wantedLocale }; };
  if (regNS) regNS(dtf, 'resolvedOptions');
  Intl.DateTimeFormat.prototype.resolvedOptions = dtf;
  if (Intl.NumberFormat?.prototype?.resolvedOptions) {
    const o = Intl.NumberFormat.prototype.resolvedOptions;
    const nf = function() { const r = o.call(this); return { ...r, locale: wantedLocale }; };
    if (regNS) regNS(nf, 'resolvedOptions');
    Intl.NumberFormat.prototype.resolvedOptions = nf;
  }
  if (Intl.Collator?.prototype?.resolvedOptions) {
    const o = Intl.Collator.prototype.resolvedOptions;
    const cl = function() { const r = o.call(this); return { ...r, locale: wantedLocale }; };
    if (regNS) regNS(cl, 'resolvedOptions');
    Intl.Collator.prototype.resolvedOptions = cl;
  }
}

// --- HEVC codec support shim ---
// Chromium (weles's base) does not ship HEVC — only Google Chrome's proprietary
// build includes it. TikTok runs `MediaCapabilities.decodingInfo({video:{
// contentType:'video/mp4; codecs="hev1.1.6.L93.B0"'}})` during signup and
// observes `supported:false` on weles but `supported:true` on real Chrome 147
// on Mac. Cached as `hevc_support_key_v4=0` in localStorage, which webmssdk
// signs into x-mssdk-info. Spoof HEVC as supported to match real Chrome.
// Measured 2026-04-18 side-by-side on same Mac.
(function installHevcShim() {
  try {
    const isHevc = (s) => /\b(hev1|hvc1)\b/i.test(s || '');

    const regNS = window.__welesNativeString;
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) {
      const orig = MediaSource.isTypeSupported.bind(MediaSource);
      const its = function(type) { if (isHevc(type)) return true; return orig(type); };
      if (regNS) regNS(its, 'isTypeSupported');
      MediaSource.isTypeSupported = its;
    }

    if (typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype.canPlayType) {
      const origCpt = HTMLMediaElement.prototype.canPlayType;
      const cpt = function(type) { if (isHevc(type)) return 'probably'; return origCpt.call(this, type); };
      if (regNS) regNS(cpt, 'canPlayType');
      HTMLMediaElement.prototype.canPlayType = cpt;
    }

    if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
      const origDec = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
      const di = function(config) {
        try {
          const ct = config?.video?.contentType || config?.audio?.contentType || '';
          if (isHevc(ct)) {
            return Promise.resolve({
              supported: true,
              smooth: true,
              powerEfficient: true,
              configuration: config,
            });
          }
        } catch {}
        return origDec(config);
      };
      if (regNS) regNS(di, 'decodingInfo');
      navigator.mediaCapabilities.decodingInfo = di;
    }
  } catch (e) { window.__WELES_HEVC_ERR = String(e); }
})();
