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
      const clientHints = __weles.clientHints || {};
      const platformMap = { MacIntel: 'macOS', Win32: 'Windows', 'Linux x86_64': 'Linux' };
      const platform = clientHints.platform || platformMap[nav.platform] || nav.platform || navigator.userAgentData.platform || '';
      const mobile = navigator.userAgentData.mobile || false;
      const architecture = clientHints.architecture || (
        platform === 'Windows' ? 'x86' :
        platform === 'Linux' ? 'x86' :
        nav.architecture || 'arm'
      );
      const bitness = clientHints.bitness || (
        platform === 'Windows' ? '64' :
        platform === 'Linux' ? '64' :
        nav.bitness || ''
      );
      const platformVersion = clientHints.platformVersion || nav.platformVersion || '';
      const model = clientHints.model || '';

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
            platformVersion: platformVersion,
            architecture: architecture,
            bitness: bitness,
            model: model,
            uaFullVersion: fullVersion,
            wow64: Boolean(clientHints.wow64),
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
  // Screen.prototype properties are often non-configurable in Chromium, so
  // Object.defineProperty on the prototype throws. Replacing window.screen with
  // a Proxy that intercepts only the configured values keeps `screen instanceof
  // Screen` true and avoids breaking native code that reads other fields.
  try {
    const screenProxy = new Proxy(screen, {
      get(target, prop) {
        if (prop === 'availTop' && scr.availTop !== undefined) return scr.availTop;
        if (prop === 'availLeft' && scr.availLeft !== undefined) return scr.availLeft;
        if (prop === 'availWidth' && scr.availWidth !== undefined) return scr.availWidth;
        if (prop === 'availHeight' && scr.availHeight !== undefined) return scr.availHeight;
        if (prop === 'width' && scr.width !== undefined) return scr.width;
        if (prop === 'height' && scr.height !== undefined) return scr.height;
        if (prop === 'colorDepth' && scr.colorDepth !== undefined) return scr.colorDepth;
        if (prop === 'pixelDepth' && scr.pixelDepth !== undefined) return scr.pixelDepth;
        return target[prop];
      }
    });
    Object.defineProperty(window, 'screen', { get: function() { return screenProxy; }, configurable: true, enumerable: true });
  } catch (screenErr) {
    // Fallback: try prototype overrides for the fields that do allow it.
    for (const [prop, val] of Object.entries(scr)) {
      if (val !== undefined) {
        try { define(Screen.prototype, prop, function() { return val; }); } catch {}
      }
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

