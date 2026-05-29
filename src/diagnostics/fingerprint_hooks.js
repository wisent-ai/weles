// Fingerprint-surface hooks PerimeterX reads but property_trap.js does not log
// the *value* of. Reuses the stealth core property_trap installs under
// Symbol.for('weles.inst'): every method replacement goes through api.hook /
// api.makeNative, so the wrappers report native source under toString and
// carry native name/length. This file does NOT touch Function.prototype
// .toString — the shared core already cloaks it; re-hooking it (as the old
// build did) is the single most-detectable tripwire.
//   1) Canvas pixel-hash (toDataURL + getImageData) as FNV-1a + head + len.
//   2) Audio render output (startRendering + getChannelData) sample stats.
//   3) Window-level webdriver/automation flag reads.
//   4) WebRTC ICE candidate / SDP exposure.
(function(){
  const api = globalThis[Symbol.for('weles.inst')];
  if (!api || api._fpInstalled) return;
  api._fpInstalled = true;
  const logs = api.logs;
  const hook = api.hook;
  const makeNative = api.makeNative;
  function logAccess(obj, prop, vs) {
    logs.push({ t: performance.now(), o: obj, p: prop, vt: 'string', vs: vs, s: '' });
    if (logs.length > 20000) logs.shift();
  }
  function _fnv32(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function _fnv32u8(a) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // (1) Canvas content hash. Stacks on top of property_trap's canvas hooks;
  // makeNative chases the chain so toString still reports the true native.
  try {
    hook(HTMLCanvasElement.prototype, 'toDataURL', (o) => function() {
      const v = o.apply(this, arguments);
      logAccess('Canvas', 'toDataURL', 'len=' + (v ? v.length : 0) + ' h=' + (v ? _fnv32(v) : '0') + ' head=' + (v ? v.slice(0, 80) : ''));
      return v;
    });
    hook(CanvasRenderingContext2D.prototype, 'getImageData', (o) => function() {
      const v = o.apply(this, arguments);
      const d = v && v.data;
      logAccess('Canvas', 'getImageData', 'len=' + (d ? d.length : 0) + ' h=' + (d ? _fnv32u8(d) : '0'));
      return v;
    });
  } catch (e) { logAccess('_fp_', 'canvas-init-error', String(e).slice(0, 120)); }

  // (2) Audio render output hash.
  try {
    if (typeof OfflineAudioContext !== 'undefined') {
      hook(OfflineAudioContext.prototype, 'startRendering', (o) => function() {
        const p = o.apply(this, arguments);
        const me = this;
        logAccess('OfflineAudioContext', 'startRendering', 'len=' + (me.length || 0) + ' sr=' + (me.sampleRate || 0));
        return p.then(function(buf) {
          try {
            const ch = buf.getChannelData(0);
            const N = Math.min(ch.length, 1000);
            let s = 0;
            for (let i = 0; i < N; i++) s += Math.abs(ch[i]);
            const first = [];
            for (let i = 0; i < Math.min(ch.length, 200); i++) first.push(ch[i].toFixed(8));
            logAccess('OfflineAudioContext', 'renderedSum', 'samples=' + ch.length + ' sum1k=' + s.toFixed(6) + ' h=' + _fnv32(first.join(',')));
          } catch (err) { logAccess('_fp_', 'render-promise-error', String(err).slice(0, 120)); }
          return buf;
        });
      });
    }
    if (typeof AudioBuffer !== 'undefined') {
      hook(AudioBuffer.prototype, 'getChannelData', (o) => function(c) {
        const r = o.apply(this, arguments);
        try {
          const first = [];
          for (let i = 0; i < Math.min(r.length, 10); i++) first.push(r[i].toFixed(8));
          logAccess('AudioBuffer', 'getChannelData:' + c, 'len=' + r.length + ' first10=' + first.join(','));
        } catch (err) { logAccess('_fp_', 'getChannelData-error', String(err).slice(0, 120)); }
        return r;
      });
    }
  } catch (e) { logAccess('_fp_', 'audio-init-error', String(e).slice(0, 120)); }

  // (3) Window-level webdriver/automation flag reads. Pages read these as plain
  // window.X. We can only observe a read by installing an accessor — but
  // defining window.X for a name that does NOT exist makes `'X' in window` and
  // getOwnPropertyNames(window) report it, which IS the automation signature
  // anti-bot (Google GSI, PX) looks for: defining `callPhantom`/`_phantom`/
  // `domAutomationController` is self-incriminating. So we ONLY hook flags that
  // are ALREADY present (a real automation env set them); on a clean browser
  // none exist, nothing is created, and the surface is identical to real
  // Chrome. Verified 2026-05-26: unguarded version flipped Google SSO to
  // "browser may not be secure"; the `k in window` guard clears it.
  try {
    const NATIVE_GET = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get;
    const FLAG_BLOB = '__webdriver_script_fn|__webdriver_evaluate|__selenium_evaluate|__fxdriver_evaluate|__driver_unwrapped|__webdriver_unwrapped|__selenium_unwrapped|__fxdriver_unwrapped|__lastWatirAlert|__lastWatirConfirm|__lastWatirPrompt|domAutomation|domAutomationController|_phantom|callPhantom|__nightmare|_Selenium_IDE_Recorder';
    const winFlags = FLAG_BLOB.split('|');
    for (let i = 0; i < winFlags.length; i++) {
      const k = winFlags[i];
      try {
        if (!(k in window)) continue; // never CREATE an automation-flag property
        const cur = Object.getOwnPropertyDescriptor(window, k);
        if (cur && cur.configurable === false) continue;
        let val = window[k];
        const g = makeNative(function() { logAccess('window-flag', k, val === undefined ? 'undefined' : (val + '').slice(0, 80)); return val; }, NATIVE_GET);
        const s = makeNative(function(v) { val = v; }, NATIVE_GET);
        Object.defineProperty(window, k, { configurable: true, get: g, set: s });
      } catch (err) { logAccess('_fp_', 'win-flag-init:' + k, String(err).slice(0, 80)); }
    }
    try {
      if (window.chrome && window.chrome.runtime) {
        const origId = window.chrome.runtime.id;
        const g = makeNative(function() { logAccess('chrome.runtime', 'id', origId === undefined ? 'undefined' : (origId + '').slice(0, 80)); return origId; }, NATIVE_GET);
        Object.defineProperty(window.chrome.runtime, 'id', { configurable: true, get: g });
      }
    } catch (err) { logAccess('_fp_', 'chrome-runtime-init', String(err).slice(0, 80)); }
  } catch (e) { logAccess('_fp_', 'win-flags-init-error', String(e).slice(0, 120)); }

  // (4) WebRTC ICE candidate / SDP exposure — can reveal host LAN IP.
  try {
    if (typeof RTCPeerConnection !== 'undefined') {
      hook(RTCPeerConnection.prototype, 'createOffer', (o) => function() {
        const p = o.apply(this, arguments);
        return p.then(function(desc) { try { logAccess('RTCPeerConnection', 'createOffer', (desc && desc.sdp ? desc.sdp.slice(0, 4000) : 'no-sdp')); } catch {} return desc; });
      });
      hook(RTCPeerConnection.prototype, 'setLocalDescription', (o) => function(desc) {
        try { logAccess('RTCPeerConnection', 'setLocalDescription', (desc && desc.sdp ? desc.sdp.slice(0, 4000) : 'no-sdp')); } catch {}
        return o.apply(this, arguments);
      });
      hook(RTCPeerConnection.prototype, 'addIceCandidate', (o) => function(cand) {
        try { logAccess('RTCPeerConnection', 'addIceCandidate', (cand && cand.candidate ? cand.candidate.slice(0, 400) : (cand + '').slice(0, 400))); } catch {}
        return o.apply(this, arguments);
      });
    }
  } catch (e) { logAccess('_fp_', 'rtc-init-error', String(e).slice(0, 120)); }

  // (5) WebGL standard GL_VENDOR (0x1f00) / GL_RENDERER (0x1f01). Firefox's GL-parameter handler runs the webgl.{vendor,renderer}-string-override prefs through a sanitizer that emits placeholders like "Apple M1, or similar" and leaks the HOST GPU through this path even on a Windows persona. UNMASKED_*_WEBGL (0x9245/0x9246) are overridable via the public prefs, but the standard parameters need a JS shim. Tokens below are substituted from fpConfig.webgl at injection time by async_api when persona.browser !== 'chromium'; for Chromium the tokens remain literal and the startsWith check makes this a no-op so Chrome's native GL_VENDOR/GL_RENDERER ("WebKit", "WebKit WebGL") are preserved.
  const WELES_GL_VENDOR = '__WELES_GL_VENDOR__';
  const WELES_GL_RENDERER = '__WELES_GL_RENDERER__';
  const _glProtos = [typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype, typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype];
  for (const proto of _glProtos) {
    if (!proto) continue;
    try {
      hook(proto, 'getParameter', (o) => function(p) {
        if (p === 0x1f00 && !WELES_GL_VENDOR.startsWith('__WELES_')) return WELES_GL_VENDOR;
        if (p === 0x1f01 && !WELES_GL_RENDERER.startsWith('__WELES_')) return WELES_GL_RENDERER;
        return o.apply(this, arguments);
      });
    } catch (err) { logAccess('_fp_', 'webgl-getParameter-init-error', String(err).slice(0, 120)); }
  }

  logs.push({ t: performance.now(), o: '_fp_init_', p: 'done', vt: 'string', vs: 'ok', s: '' });
})();
