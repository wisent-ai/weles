// Page-side diagnostic trap (STEALTH build). Captures which navigator/screen/
// document/window properties and fingerprinting methods a page reads, for the
// human-vs-trajectory diff harness — WITHOUT leaving a surface a detector
// (Google GSI's "browser may not be secure", PerimeterX, Arkose, ...) can see.
//
// Three stealth measures vs the pre-2026-05-26 build, which Google flagged:
//   1) Exfil lives under Symbol.for('weles.inst'), NOT window.__inst* globals,
//      so it is invisible to `if (window.__inst)` / Object.keys(window) /
//      for-in / JSON enumeration. Only an explicit getOwnPropertySymbols scan
//      (which a normal page never runs) can find it.
//   2) Every wrapper we install reports its ORIGINAL's native source via a
//      single Function.prototype.toString proxy — so e.g.
//      Object.getOwnPropertyDescriptor(Navigator.prototype,'userAgent').get
//      .toString() returns "function get userAgent() { [native code] }", not
//      our JS — and carries the original .name and .length.
//   3) We NEVER install a *logging* Function.prototype.toString hook. The old
//      build did (twice), which is itself the canonical detection tripwire:
//      Function.prototype.toString.toString() then leaks the wrapper source.
//
// Sibling injectors (input_recorder.js, fingerprint_hooks.js) reuse this core
// via the same symbol, so they inherit identical stealth.
(function(){
  const SYM = Symbol.for('weles.inst');
  if (globalThis[SYM]) return;

  const logs = [];
  // Real EventTarget.addEventListener, saved BEFORE the wrap below replaces it,
  // so the input recorder can register listeners without polluting the trap log.
  const origAddEL = EventTarget.prototype.addEventListener;

  // ---- stealth toString core ---------------------------------------------
  // One proxy on Function.prototype.toString. For any wrapper we register in
  // `natives`, it returns the ORIGINAL's source (native code); for itself it
  // returns a native toString string. Every internal call uses the captured
  // native `oTS`, never the proxy, so there is no recursion.
  const oTS = Function.prototype.toString;
  const nativeTSStr = oTS.call(oTS);
  const natives = new WeakMap(); // wrapper fn -> original fn
  const tsProxy = new Proxy(oTS, {
    apply(target, thisArg, args) {
      try { if (thisArg && natives.has(thisArg)) return oTS.call(natives.get(thisArg)); } catch {}
      if (thisArg === tsProxy) return nativeTSStr;
      return oTS.apply(thisArg, args);
    },
  });
  try { Object.defineProperty(Function.prototype, 'toString', { value: tsProxy, writable: true, configurable: true }); } catch {}

  // Register `wrapper` so it impersonates `original` under toString/name/length.
  // If `original` is itself one of our wrappers (double-wrapping, e.g.
  // fingerprint_hooks stacking on top of a method property_trap already hooked),
  // chase the chain to the TRUE native so toString never leaks a JS wrapper.
  function makeNative(wrapper, original) {
    try { while (natives.has(original)) original = natives.get(original); } catch {}
    try { natives.set(wrapper, original); } catch {}
    try { Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true }); } catch {}
    try { Object.defineProperty(wrapper, 'length', { value: original.length, configurable: true }); } catch {}
    return wrapper;
  }

  // ---- logging ------------------------------------------------------------
  function stack() {
    try {
      const s = new Error().stack || '';
      const lines = s.split('\n').slice(2);
      for (const l of lines) { if (!l.includes('property_trap') && !l.includes('native code')) return l.trim().slice(0, 180); }
      return lines[0] ? lines[0].trim().slice(0, 180) : '';
    } catch { return ''; }
  }
  function logAccess(obj, prop, val) {
    try {
      let vs = ''; const vt = typeof val;
      if (val === null) vs = 'null';
      else if (vt === 'undefined') vs = 'undefined';
      else if (vt === 'function') vs = 'function';
      else if (vt === 'object') { try { vs = JSON.stringify(val).slice(0, 200); } catch { vs = '[object]'; } }
      else vs = String(val).slice(0, 200);
      logs.push({ t: performance.now(), o: obj, p: prop, vt, vs, s: stack() });
      if (logs.length > 20000) logs.shift();
    } catch {}
  }

  // Replace obj[prop] with make(orig), preserving native identity. make(orig)
  // returns the replacement function.
  function hook(obj, prop, make) {
    try {
      const orig = obj[prop];
      if (typeof orig !== 'function') return;
      obj[prop] = makeNative(make(orig), orig);
    } catch {}
  }

  // Wrap every configurable accessor getter on a prototype, native-clean.
  function wrapGetters(target, name) {
    try {
      const proto = Object.getPrototypeOf(target);
      const descs = Object.getOwnPropertyDescriptors(proto);
      for (const [prop, desc] of Object.entries(descs)) {
        if (!desc.configurable || prop === 'constructor' || !desc.get) continue;
        const origGet = desc.get;
        const newGet = makeNative(function() { const v = origGet.call(this); logAccess(name, prop, v); return v; }, origGet);
        try { Object.defineProperty(proto, prop, { configurable: true, enumerable: desc.enumerable, get: newGet, set: desc.set }); } catch {}
      }
    } catch (e) { logs.push({ t: performance.now(), o: name, p: '<wrap-error>', vt: 'string', vs: String(e).slice(0, 120), s: '' }); }
  }

  wrapGetters(navigator, 'navigator');
  wrapGetters(screen, 'screen');
  wrapGetters(document, 'document');
  try { wrapGetters(document.documentElement, 'documentElement'); } catch {}
  try { wrapGetters(window, 'window'); } catch {}
  try { wrapGetters(performance, 'performance'); } catch {}
  try { wrapGetters(location, 'location'); } catch {}
  try { wrapGetters(history, 'history'); } catch {}

  hook(WebGLRenderingContext.prototype, 'getParameter', (o) => function(p) { const v = o.apply(this, arguments); logAccess('WebGL', '0x' + (p || 0).toString(16), v); return v; });
  try { hook(WebGL2RenderingContext.prototype, 'getParameter', (o) => function(p) { const v = o.apply(this, arguments); logAccess('WebGL2', '0x' + (p || 0).toString(16), v); return v; }); } catch {}

  hook(HTMLCanvasElement.prototype, 'toDataURL', (o) => function() { const v = o.apply(this, arguments); logAccess('Canvas', 'toDataURL', 'len=' + (v ? v.length : 0)); return v; });
  hook(CanvasRenderingContext2D.prototype, 'getImageData', (o) => function() { const v = o.apply(this, arguments); logAccess('Canvas', 'getImageData', 'len=' + (v?.data?.length || 0)); return v; });

  try { hook(OfflineAudioContext.prototype, 'createOscillator', (o) => function() { logAccess('OfflineAudioContext', 'createOscillator', ''); return o.apply(this, arguments); }); } catch {}
  try { hook(Performance.prototype, 'getEntriesByType', (o) => function(t) { const v = o.apply(this, arguments); logAccess('Performance', 'getEntriesByType:' + t, 'n=' + (v?.length || 0)); return v; }); } catch {}
  try { hook(Storage.prototype, 'setItem', (o) => function(k, v) { logAccess('Storage', 'setItem:' + k, (v + '').slice(0, 80)); return o.apply(this, arguments); }); } catch {}
  try { hook(Storage.prototype, 'getItem', (o) => function(k) { const r = o.apply(this, arguments); logAccess('Storage', 'getItem:' + k, r === null ? 'null' : (r + '').slice(0, 80)); return r; }); } catch {}
  try { if (navigator.permissions) hook(navigator.permissions, 'query', (o) => function(desc) { logAccess('Permissions', 'query:' + (desc?.name || '?'), ''); return o.apply(this, arguments); }); } catch {}

  try { if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) hook(MediaSource, 'isTypeSupported', (o) => function(mime) { const r = o.call(this, mime); logAccess('MediaSource', 'isTypeSupported:' + String(mime).slice(0, 80), String(r)); return r; }); } catch {}
  try { hook(HTMLMediaElement.prototype, 'canPlayType', (o) => function(mime) { const r = o.call(this, mime); logAccess('HTMLMediaElement', 'canPlayType:' + String(mime).slice(0, 80), String(r)); return r; }); } catch {}
  try {
    if (navigator.mediaCapabilities) for (const k of ['decodingInfo', 'encodingInfo']) {
      hook(navigator.mediaCapabilities, k, (o) => function(cfg) { let key = ''; try { key = JSON.stringify(cfg).slice(0, 120); } catch {} return o.call(this, cfg).then(r => { let v = ''; try { v = JSON.stringify(r).slice(0, 120); } catch {} logAccess('MediaCapabilities', k + ':' + key, v); return r; }); });
    }
  } catch {}
  try { hook(Document.prototype, 'hasFocus', (o) => function() { const r = o.call(this); logAccess('Document', 'hasFocus', String(r)); return r; }); } catch {}
  try { if (typeof navigator.getBattery === 'function') hook(navigator, 'getBattery', (o) => function() { return o.call(this).then(b => { let v = ''; try { v = JSON.stringify({ charging: b.charging, level: b.level }); } catch {} logAccess('Navigator', 'getBattery', v); return b; }); }); } catch {}
  try { hook(Date.prototype, 'getTimezoneOffset', (o) => function() { const r = o.call(this); logAccess('Date', 'getTimezoneOffset', String(r)); return r; }); } catch {}
  try { hook(Intl.DateTimeFormat.prototype, 'resolvedOptions', (o) => function() { const r = o.call(this); logAccess('Intl.DateTimeFormat', 'resolvedOptions', r?.timeZone + '|' + r?.locale); return r; }); } catch {}
  try { if (navigator.mediaDevices?.enumerateDevices) hook(navigator.mediaDevices, 'enumerateDevices', (o) => function() { return o.call(this).then(d => { logAccess('MediaDevices', 'enumerateDevices', 'n=' + (d?.length || 0)); return d; }); }); } catch {}
  try { hook(EventTarget.prototype, 'addEventListener', (o) => function(type, listener, opts) { logAccess('EventTarget', 'addEventListener:' + type, String(this?.constructor?.name || 'unknown')); return o.call(this, type, listener, opts); }); } catch {}
  try { hook(PerformanceObserver.prototype, 'observe', (o) => function(opts) { let key = ''; try { key = JSON.stringify(opts).slice(0, 100); } catch {} logAccess('PerformanceObserver', 'observe', key); return o.call(this, opts); }); } catch {}

  // SubtleCrypto.encrypt — Arkose encrypts the fingerprint blob before POSTing
  // to /fc/gt2/public_key; logging the plaintext reveals what was serialised.
  try {
    if (crypto?.subtle?.encrypt) hook(crypto.subtle, 'encrypt', (o) => function(alg, key, data) {
      try {
        const nm = (alg && (alg.name || alg)) + '';
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : (data?.buffer ? new Uint8Array(data.buffer) : new Uint8Array());
        const text = new TextDecoder('utf-8', { fatal: false }).decode(buf).slice(0, 50000);
        logs.push({ t: performance.now(), o: 'SubtleCrypto', p: 'encrypt:' + nm, vt: 'string', vs: text, s: stack() });
      } catch {}
      return o.call(this, alg, key, data);
    });
  } catch {}

  try { hook(XMLHttpRequest.prototype, 'open', (o) => function(method, url) { try { logAccess('XHR', 'open:' + method, (url + '').slice(0, 120)); } catch {} return o.apply(this, arguments); }); } catch {}
  try { hook(XMLHttpRequest.prototype, 'send', (o) => function(body) { try { logAccess('XHR', 'send', (typeof body === 'string' ? body : '[non-string]').slice(0, 600)); } catch {} return o.apply(this, arguments); }); } catch {}

  // window.fetch — Reddit/GraphQL POSTs bypass XHR; log URL, method, body, status.
  try {
    hook(window, 'fetch', (o) => function(input, init) {
      let url = '', method = 'GET', body = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input && typeof input === 'object') { url = input.url || ''; method = input.method || 'GET'; }
        if (init) { if (init.method) method = init.method; const b = init.body; if (typeof b === 'string') body = b.slice(0, 4000); else if (b instanceof URLSearchParams) body = b.toString().slice(0, 4000); else if (typeof FormData !== 'undefined' && b instanceof FormData) body = '[FormData]'; else if (b && b.byteLength != null) body = '[binary len=' + b.byteLength + ']'; }
      } catch {}
      logAccess('Fetch', String(method).toUpperCase() + ':' + url.slice(0, 200), body);
      return o.apply(this, arguments).then(function(r) { try { logAccess('Fetch', 'res:' + url.slice(0, 200), 'status=' + r.status); } catch {} return r; });
    });
  } catch (e) { logs.push({ t: performance.now(), o: '_fetch_', p: '<init-error>', vt: 'string', vs: String(e).slice(0, 120), s: '' }); }

  logs.push({ t: performance.now(), o: '_init_', p: 'done', vt: 'string', vs: 'ok', s: '' });

  // Hidden exfil + shared core for sibling injectors. Non-enumerable symbol key.
  try {
    Object.defineProperty(globalThis, SYM, {
      value: { logs, flush: () => JSON.stringify(logs), logAccess, wrapGetters, makeNative, hook, origAddEL },
      enumerable: false, configurable: true, writable: false,
    });
  } catch {}
})();
