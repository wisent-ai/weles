// Shared fingerprint probe.
//
// Single source of truth for "what does my browser look like to a fingerprinter".
// Called by the fingerprint capture path (Bright Data reference Chrome and our
// weles Chromium) and by the TikTok
// instrumented probes. Any field added here shows up in every downstream diff.
//
// Goal: measure the full JS-accessible fingerprint surface that anti-bot SDKs
// (TikTok mssdk, Cloudflare, Akamai, PerimeterX, BotD) actually read. Pair with
// parseNetworkFingerprint() which parses tls.peet.ws output for TLS+H2 details.

export const FP_SCRIPT = String.raw`(async () => {
  const r = {};
  const safe = (fn) => { try { return fn(); } catch (e) { return { _err: String(e).slice(0, 100) }; } };

  // ---- 1. navigator ----
  const n = navigator;
  r.navigator = {
    userAgent: n.userAgent, appVersion: n.appVersion, appCodeName: n.appCodeName,
    appName: n.appName, platform: n.platform, vendor: n.vendor, vendorSub: n.vendorSub,
    product: n.product, productSub: n.productSub, buildID: n.buildID, oscpu: n.oscpu,
    cpuClass: n.cpuClass, language: n.language, languages: Array.from(n.languages || []),
    webdriver: n.webdriver, hardwareConcurrency: n.hardwareConcurrency,
    deviceMemory: n.deviceMemory, maxTouchPoints: n.maxTouchPoints, doNotTrack: n.doNotTrack,
    cookieEnabled: n.cookieEnabled, pdfViewerEnabled: n.pdfViewerEnabled,
    onLine: n.onLine, javaEnabled: safe(() => n.javaEnabled()),
    plugins: Array.from(n.plugins || []).map(p => ({ name: p.name, filename: p.filename, description: p.description, length: p.length })),
    mimeTypes: Array.from(n.mimeTypes || []).map(m => ({ type: m.type, suffixes: m.suffixes, description: m.description })),
    connection: n.connection ? { effectiveType: n.connection.effectiveType, downlink: n.connection.downlink, rtt: n.connection.rtt, saveData: n.connection.saveData, type: n.connection.type } : null,
  };

  // ---- 2. userAgentData (Client Hints) ----
  r.userAgentData = await (async () => {
    try {
      if (!n.userAgentData) return null;
      const high = await n.userAgentData.getHighEntropyValues(
        ['architecture', 'bitness', 'brands', 'mobile', 'model', 'platform', 'platformVersion', 'uaFullVersion', 'fullVersionList', 'wow64', 'formFactors']
      );
      return { brands: n.userAgentData.brands, mobile: n.userAgentData.mobile, platform: n.userAgentData.platform, ...high };
    } catch (e) { return { _err: String(e).slice(0, 100) }; }
  })();

  // ---- 3. screen + window ----
  r.screen = { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, availLeft: screen.availLeft, availTop: screen.availTop, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth, orientation: safe(() => ({ type: screen.orientation?.type, angle: screen.orientation?.angle })) };
  r.window = { devicePixelRatio: window.devicePixelRatio, outerWidth: window.outerWidth, outerHeight: window.outerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenX: window.screenX, screenY: window.screenY, scrollX: window.scrollX, scrollY: window.scrollY, chromeToolbarPx: window.outerHeight - window.innerHeight };

  // ---- 4. WebGL 1 full parameter dump ----
  r.webgl1 = safe(() => {
    const c = document.createElement('canvas'); const gl = c.getContext('webgl'); if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const paramNames = 'VENDOR RENDERER VERSION SHADING_LANGUAGE_VERSION MAX_TEXTURE_SIZE MAX_VIEWPORT_DIMS MAX_VERTEX_ATTRIBS MAX_VERTEX_UNIFORM_VECTORS MAX_VARYING_VECTORS MAX_COMBINED_TEXTURE_IMAGE_UNITS MAX_VERTEX_TEXTURE_IMAGE_UNITS MAX_TEXTURE_IMAGE_UNITS MAX_FRAGMENT_UNIFORM_VECTORS MAX_CUBE_MAP_TEXTURE_SIZE MAX_RENDERBUFFER_SIZE ALIASED_LINE_WIDTH_RANGE ALIASED_POINT_SIZE_RANGE RED_BITS GREEN_BITS BLUE_BITS ALPHA_BITS DEPTH_BITS STENCIL_BITS SUBPIXEL_BITS SAMPLE_BUFFERS SAMPLES'.split(' ');
    const params = {};
    for (const k of paramNames) { try { const v = gl.getParameter(gl[k]); params[k] = Array.isArray(v) || v instanceof Float32Array || v instanceof Int32Array ? Array.from(v) : v; } catch (e) { params[k] = null; } }
    params.UNMASKED_VENDOR = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
    params.UNMASKED_RENDERER = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
    const precisionNames = 'LOW_FLOAT MEDIUM_FLOAT HIGH_FLOAT LOW_INT MEDIUM_INT HIGH_INT'.split(' ');
    const prec = {};
    for (const k of precisionNames) {
      try { const v = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl[k]); prec[k] = v ? { precision: v.precision, rangeMin: v.rangeMin, rangeMax: v.rangeMax } : null; } catch (e) { prec[k] = null; }
    }
    return { params, precision: prec, extensions: gl.getSupportedExtensions() || [] };
  });

  // ---- 5. WebGL 2 ----
  r.webgl2 = safe(() => {
    const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); if (!gl) return { supported: false };
    return { supported: true, version: gl.getParameter(gl.VERSION), shadingVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), extensions: gl.getSupportedExtensions() || [] };
  });

  // ---- 6. canvas 2D — hash + text metrics ----
  r.canvas = safe(() => {
    const cv = document.createElement('canvas'); cv.width = 240; cv.height = 60;
    const cx = cv.getContext('2d'); cx.textBaseline = 'top'; cx.font = '14px Arial';
    cx.fillStyle = '#f60'; cx.fillRect(125, 1, 62, 20);
    cx.fillStyle = '#069'; cx.fillText('Cwm fjord veg', 2, 15);
    cx.fillStyle = 'rgba(102,204,0,0.7)'; cx.fillText('bangs gym waltz', 4, 45);
    const dataUrl = cv.toDataURL();
    const tm = cx.measureText('Hello');
    return { toDataURLLen: dataUrl.length, toDataURLHead: dataUrl.slice(0, 80), textMetrics: { width: tm.width, actualBoundingBoxAscent: tm.actualBoundingBoxAscent, actualBoundingBoxDescent: tm.actualBoundingBoxDescent, actualBoundingBoxLeft: tm.actualBoundingBoxLeft, actualBoundingBoxRight: tm.actualBoundingBoxRight, fontBoundingBoxAscent: tm.fontBoundingBoxAscent, fontBoundingBoxDescent: tm.fontBoundingBoxDescent } };
  });

  // ---- 7. AudioContext fingerprint via OfflineAudioContext ----
  r.audio = await (async () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
      const live = new AC();
      const baseInfo = { sampleRate: live.sampleRate, state: live.state, baseLatency: live.baseLatency, maxChannels: live.destination.maxChannelCount };
      live.close?.();
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      let oacHash = null;
      if (OAC) {
        const oac = new OAC(1, 5000, 44100);
        const osc = oac.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
        const comp = oac.createDynamicsCompressor();
        osc.connect(comp); comp.connect(oac.destination); osc.start(0);
        const buf = await oac.startRendering();
        const data = buf.getChannelData(0);
        let sum = 0; for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
        oacHash = sum.toFixed(16);
      }
      return { ...baseInfo, oacHash };
    } catch (e) { return { _err: String(e).slice(0, 100) }; }
  })();

  // ---- 8. Intl / timezone ----
  r.intl = safe(() => {
    const dtf = new Intl.DateTimeFormat().resolvedOptions();
    const nf = new Intl.NumberFormat().resolvedOptions();
    return { timezone: dtf.timeZone, locale: dtf.locale, calendar: dtf.calendar, numberingSystem: dtf.numberingSystem, dtfHour12: dtf.hour12, nfLocale: nf.locale, tzOffset: new Date().getTimezoneOffset(), segmenter: typeof Intl.Segmenter !== 'undefined', relativeTimeFormat: typeof Intl.RelativeTimeFormat !== 'undefined' };
  });

  // ---- 9. chrome.* globals ----
  r.chrome = safe(() => ({ exists: typeof window.chrome !== 'undefined', runtime: !!window.chrome?.runtime, app: !!window.chrome?.app, csi: typeof window.chrome?.csi === 'function', loadTimes: typeof window.chrome?.loadTimes === 'function' }));

  // ---- 9b. notification permission (checked explicitly by PerimeterX / BotD) ----
  r.notification = safe(() => ({ permission: window.Notification?.permission }));

  // ---- 10. permissions (multiple) ----
  r.permissions = await (async () => {
    try {
      const names = 'notifications geolocation camera microphone clipboard-read clipboard-write persistent-storage midi accelerometer gyroscope'.split(' ');
      const out = {};
      for (const p of names) { try { const s = await n.permissions.query({ name: p }); out[p] = s.state; } catch { out[p] = 'unsupported'; } }
      return out;
    } catch (e) { return { _err: String(e).slice(0, 100) }; }
  })();

  // ---- 11. storage quota ----
  r.storage = await (async () => { try { return n.storage && n.storage.estimate ? await n.storage.estimate() : null; } catch (e) { return { _err: String(e).slice(0, 100) }; } })();

  // ---- 12. mediaDevices ----
  r.mediaDevices = await (async () => {
    try {
      if (!n.mediaDevices?.enumerateDevices) return null;
      const devs = await n.mediaDevices.enumerateDevices();
      return devs.map(d => ({ kind: d.kind, label: d.label ? 'present' : 'blank', deviceIdLen: d.deviceId.length, groupIdLen: d.groupId.length }));
    } catch (e) { return { _err: String(e).slice(0, 100) }; }
  })();

  // ---- 12b. WebRTC local IP leak (PerimeterX checks this) ----
  r.webRTC = await (async () => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const ips = new Set();
      pc.createDataChannel('weles-diag');
      pc.onicecandidate = (e) => {
        if (!e.candidate?.candidate) return;
        const m = e.candidate.candidate.match(/([0-9]{1,3}\.){3}[0-9]{1,3}/);
        if (m) ips.add(m[0]);
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(r => setTimeout(r, 1000));
      pc.close();
      return { localIPs: Array.from(ips) };
    } catch (e) { return { _err: String(e).slice(0, 100), localIPs: [] }; }
  })();

  // ---- 13. speechSynthesis voices ----
  r.speechVoices = safe(() => {
    const v = window.speechSynthesis?.getVoices() || [];
    return { count: v.length, voices: v.slice(0, 20).map(x => ({ name: x.name, lang: x.lang, localService: x.localService, default: x.default })) };
  });

  // ---- 14. battery ----
  r.battery = await (async () => { try { return n.getBattery ? await n.getBattery().then(b => ({ charging: b.charging, level: b.level, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime })) : null; } catch (e) { return { _err: String(e).slice(0, 100) }; } })();

  // ---- 15. keyboard layout ----
  r.keyboard = await (async () => { try { return n.keyboard?.getLayoutMap ? { size: (await n.keyboard.getLayoutMap()).size } : null; } catch (e) { return { _err: String(e).slice(0, 100) }; } })();

  // ---- 16. fonts ----
  r.fonts = safe(() => {
    const probe = (f) => { try { const cv = document.createElement('canvas'); const cx = cv.getContext('2d'); cx.font = '16px ' + JSON.stringify(f) + ', serif'; const a = cx.measureText('mmMwWLlIi').width; cx.font = '16px serif'; const b = cx.measureText('mmMwWLlIi').width; return a !== b; } catch { return false; } };
    const list = 'Arial Helvetica Times Courier Verdana Georgia Tahoma Palatino Menlo Monaco Consolas SimSun Roboto'.split(' ');
    const out = {}; for (const f of list) out[f] = probe(f); return out;
  });

  // ---- 17. Math precision values ----
  r.math = safe(() => ({
    sin1: Math.sin(1).toString(), cos1: Math.cos(1).toString(), tan1: Math.tan(1).toString(),
    expE: Math.exp(1).toString(), pow2_53: Math.pow(2, 53).toString(), log2_e: Math.log2(Math.E).toString(),
    atanh: Math.atanh(0.5).toString(), acosh: Math.acosh(1e300).toString(), sinh1: Math.sinh(1).toString(),
  }));

  // ---- 18. Error stack format ----
  r.errorStack = safe(() => { try { null.foo; } catch (e) { return { name: e.name, messagePrefix: e.message.slice(0, 40), stackLines: e.stack.split('\n').length, stackFirstLine: e.stack.split('\n')[0].slice(0, 80) }; } });

  // ---- 19. JS engine toString lengths ----
  r.jsEngine = safe(() => ({ evalLen: eval.toString().length, fnToStringLen: Function.prototype.toString.toString().length, promiseThenLen: Promise.prototype.then.toString().length }));

  // ---- 20. BotD distinctive props + ALL window own-property names (for diff) ----
  r.ownPropsCount = safe(() => Object.getOwnPropertyNames(window).length);
  r.ownProps = safe(() => Object.getOwnPropertyNames(window).sort());
  r.distinctivePropsHits = safe(() => {
    const own = new Set(Object.getOwnPropertyNames(window));
    const docOwn = new Set(Object.getOwnPropertyNames(document));
    const patterns = 'awesomium:awesomium|cef:RunPerfTest|cefsharp:CefSharp|coachjs:emit|fminer:fmget_targets|geb:geb|nightmarejs:__nightmare,nightmare|phantomas:__phantomas|phantomjs:callPhantom,_phantom|rhino:spawn|selenium_w:_Selenium_IDE_Recorder,_selenium,calledSelenium|webdriverio:wdioElectron|webdriver_w:webdriver,__webdriverFunc,_WEBDRIVER_ELEM_CACHE,ChromeDriverw|headless_chrome:domAutomation,domAutomationController|webdriver_d:__webdriver_evaluate,__driver_evaluate,$cdc_asdjflasutopfhvcZLmcf'.split('|');
    const hits = {};
    for (const entry of patterns) { const [k, propsStr] = entry.split(':'); const props = propsStr.split(','); const inWin = props.filter(p => own.has(p)); const inDoc = props.filter(p => docOwn.has(p)); if (inWin.length || inDoc.length) hits[k] = { window: inWin, document: inDoc }; }
    return hits;
  });

  // ---- 21. matchMedia / CSS feature detection ----
  r.mediaQueries = safe(() => ({
    dark: matchMedia('(prefers-color-scheme: dark)').matches, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    pointerCoarse: matchMedia('(pointer: coarse)').matches, hoverHover: matchMedia('(hover: hover)').matches,
    dynamicRange: matchMedia('(dynamic-range: high)').matches, forcedColors: matchMedia('(forced-colors: active)').matches,
  }));

  // ---- 22. performance — time origin + now() precision ----
  r.performance = await (async () => {
    try {
      const samples = [];
      for (let i = 0; i < 5; i++) {
        samples.push(performance.now());
        if (i < 4) await new Promise(r => setTimeout(r, 5 + Math.floor(Math.random() * 10)));
      }
      const deltas = samples.slice(1).map((v, i) => v - samples[i]);
      return { timeOrigin: performance.timeOrigin, nowSamples: samples, nowMinDelta: Math.min(...deltas), nowMaxDelta: Math.max(...deltas) };
    } catch (e) { return { _err: String(e).slice(0, 100) }; }
  })();

  // ---- 23. document attributes + cookies ----
  r.document = safe(() => ({
    docAttrs: Array.from(document.documentElement.attributes || []).map(a => a.name),
    cookieEmpty: document.cookie === '', cookieLen: document.cookie.length, characterSet: document.characterSet, readyState: document.readyState,
  }));

  return r;
})()`;

export const NETWORK_FP_URL = 'https://tls.peet.ws/api/all';

export interface NetworkFingerprint {
  ja3?: string; ja3_hash?: string; ja4?: string; peetprint?: string; peetprint_hash?: string;
  ciphers?: string[]; extensions?: string[]; supportedVersions?: string[]; signatureAlgorithms?: string[]; groups?: string[];
  akamaiH2?: string; h2Frames?: unknown[]; ip?: string; userAgent?: string; headers?: Record<string, string>;
}

export function parseNetworkFingerprint(raw: string): NetworkFingerprint | { _err: string; raw: string } {
  try {
    const j = JSON.parse(raw);
    return {
      ja3: j.tls?.ja3, ja3_hash: j.tls?.ja3_hash, ja4: j.tls?.ja4, peetprint: j.tls?.peetprint, peetprint_hash: j.tls?.peetprint_hash,
      ciphers: j.tls?.ciphers, extensions: j.tls?.extensions?.map((e: any) => e.name ?? e),
      supportedVersions: j.tls?.supported_versions, signatureAlgorithms: j.tls?.signature_algorithms, groups: j.tls?.supported_groups ?? j.tls?.elliptic_curves,
      akamaiH2: j.http2?.akamai_fingerprint, h2Frames: j.http2?.sent_frames, ip: j.ip, userAgent: j.user_agent, headers: j.headers,
    };
  } catch (e) { return { _err: String(e).slice(0, 100), raw: raw.slice(0, 500) }; }
}
