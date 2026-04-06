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
      const seed = parseInt(majorVersion) % 3;
      const greaseyBrands = [
        {brand: 'Not/A)Brand', version: '8'},
        {brand: 'Not A;Brand', version: '99'},
        {brand: 'Not_A Brand', version: '8'},
      ];
      const greasey = greaseyBrands[seed];
      const brands = [
        greasey,
        {brand: 'Chromium', version: majorVersion},
        {brand: 'Google Chrome', version: majorVersion},
      ];
      const fullBrands = [
        {brand: greasey.brand, version: greasey.version + '.0.0.0'},
        {brand: 'Chromium', version: fullVersion},
        {brand: 'Google Chrome', version: fullVersion},
      ];
      const platform = nav.platform || navigator.userAgentData.platform || '';
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
