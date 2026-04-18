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
  Date.prototype.getTimezoneOffset = function() { return offset; };
}

// --- SpeechSynthesis voices (disabled as A/B test) ---
// Real Mac Chrome exposes ~68 system TTS voices via speechSynthesis.getVoices().
// Zero voices on a real Mac is impossible. But after enabling this override
// the signup regressed from "blocked at register_verify_login" to "blocked at
// region" — possibly because our synthetic voice list doesn't match what
// TikTok knows this machine should have. Toggle via WELES_SPOOF_SPEECH=1.
if (false && typeof speechSynthesis !== 'undefined') (function installSpeechVoices() {
  try {
  if (typeof speechSynthesis === 'undefined') { window.__WELES_SPEECH_SKIP = 'no-speech'; return; }
  const os = __weles?.clientHints?.platform;
  window.__WELES_SPEECH_OS = os;
  const macVoices = 'Daniel|en-GB|true|true,Albert|en-US|true|false,Alice|it-IT|true|false,Alva|sv-SE|true|false,Amélie|fr-CA|true|false,Amira|ms-MY|true|false,Anna|de-DE|true|false,Bad News|en-US|true|false,Bahh|en-US|true|false,Bells|en-US|true|false,Boing|en-US|true|false,Bubbles|en-US|true|false,Carmit|he-IL|true|false,Cellos|en-US|true|false,Damayanti|id-ID|true|false,Daria|bg-BG|true|false,Wobble|en-US|true|false,Eddy (German (Germany))|de-DE|true|false,Eddy (English (US))|en-US|true|false,Eddy (Spanish (Spain))|es-ES|true|false,Eddy (Spanish (Mexico))|es-MX|true|false,Eddy (Finnish (Finland))|fi-FI|true|false,Eddy (French (Canada))|fr-CA|true|false,Eddy (French (France))|fr-FR|true|false,Eddy (Italian (Italy))|it-IT|true|false,Eddy (Portuguese (Brazil))|pt-BR|true|false,Ellen|nl-BE|true|false,Flo (German (Germany))|de-DE|true|false,Flo (English (US))|en-US|true|false,Flo (Spanish (Spain))|es-ES|true|false,Flo (Spanish (Mexico))|es-MX|true|false,Fred|en-US|true|false,Good News|en-US|true|false,Grandma (German (Germany))|de-DE|true|false,Grandma (English (US))|en-US|true|false,Grandpa (German (Germany))|de-DE|true|false,Grandpa (English (US))|en-US|true|false,Jester|en-US|true|false,Ioana|ro-RO|true|false,Joana|pt-PT|true|false,Jorge|es-ES|true|false,Juan|es-MX|true|false,Kanya|th-TH|true|false,Karen|en-AU|true|false,Kathy|en-US|true|false,Kyoko|ja-JP|true|false,Lana|hr-HR|true|false,Laura|sk-SK|true|false,Lekha|hi-IN|true|false,Lesya|uk-UA|true|false,Linh|vi-VN|true|false,Luciana|pt-BR|true|false,Majed|ar|true|false,Tünde|hu-HU|true|false,Meijia|zh-TW|true|false,Melina|el-GR|true|false,Milena|ru-RU|true|false,Moira|en-IE|true|false,Mónica|es-ES|true|false,Montse|ca-ES|true|false,Nora|nb-NO|true|false,Organ|en-US|true|false,Paulina|es-MX|true|false,Superstar|en-US|true|false,Ralph|en-US|true|false,Reed (German (Germany))|de-DE|true|false,Reed (English (US))|en-US|true|false,Rishi|en-IN|true|false,Rocko (German (Germany))|de-DE|true|false,Rocko (English (US))|en-US|true|false,Samantha|en-US|true|false,Sandy (German (Germany))|de-DE|true|false,Sandy (English (US))|en-US|true|false,Sara|da-DK|true|false,Satu|fi-FI|true|false,Shelley (German (Germany))|de-DE|true|false,Shelley (English (US))|en-US|true|false,Sinji|zh-HK|true|false,Tessa|en-ZA|true|false,Thomas|fr-FR|true|false,Tingting|zh-CN|true|false,Trinoids|en-US|true|false,Whisper|en-US|true|false,Xander|nl-NL|true|false,Yelda|tr-TR|true|false,Yuna|ko-KR|true|false,Zarvox|en-US|true|false,Zosia|pl-PL|true|false,Zuzana|cs-CZ|true|false';
  const winVoices = 'Microsoft David - English (United States)|en-US|true|true,Microsoft Mark - English (United States)|en-US|true|false,Microsoft Zira - English (United States)|en-US|true|false,Microsoft Hazel - English (Great Britain)|en-GB|true|false,Microsoft Helena - Spanish (Spain)|es-ES|true|false,Microsoft Hedda - German (Germany)|de-DE|true|false,Microsoft Hortense - French (France)|fr-FR|true|false,Microsoft Elsa - Italian (Italy)|it-IT|true|false,Microsoft Haruka - Japanese (Japan)|ja-JP|true|false,Microsoft Heami - Korean (Korea)|ko-KR|true|false,Microsoft Huihui - Chinese (Simplified, PRC)|zh-CN|true|false,Microsoft Tracy - Chinese (Traditional, Hong Kong SAR)|zh-HK|true|false,Microsoft Hanhan - Chinese (Traditional, Taiwan)|zh-TW|true|false,Microsoft Irina - Russian (Russia)|ru-RU|true|false,Microsoft Maria - Portuguese (Brazil)|pt-BR|true|false,Microsoft Heera - English (India)|en-IN|true|false';
  const raw = os === 'macOS' ? macVoices : os === 'Windows' ? winVoices : macVoices;
  const voices = raw.split(',').map(r => { const [name, lang, local, def] = r.split('|'); return { name, lang, localService: local === 'true', default: def === 'true', voiceURI: `com.apple.voice.compact.${lang}.${name.replace(/\s/g, '')}` }; });
  const voiceObjs = voices.map(v => Object.freeze(v));
  // Override on BOTH the prototype and the instance. Some DOM methods are defined
  // non-writable on prototypes — direct instance assignment works; prototype needs
  // defineProperty with configurable=true.
  try { Object.defineProperty(SpeechSynthesis.prototype, 'getVoices', { value: function() { return voiceObjs; }, writable: true, configurable: true, enumerable: false }); } catch (e) { window.__WELES_SPEECH_ERR2 = String(e); }
  try { speechSynthesis.getVoices = function() { return voiceObjs; }; } catch (e) { window.__WELES_SPEECH_ERR3 = String(e); }
  window.__WELES_SPEECH_VOICES = voiceObjs.length;
  setTimeout(() => { try { speechSynthesis.dispatchEvent?.(new Event('voiceschanged')); } catch {} }, 0);
  } catch (e) { window.__WELES_SPEECH_ERR_TOP = String(e); }
})();
