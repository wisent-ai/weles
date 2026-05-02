(function(){
  if (window.__inst) return;
  const logs = [];
  window.__inst = logs;
  window.__inst_flush = () => JSON.stringify(logs);

  // Save raw EventTarget.addEventListener BEFORE the wrap below replaces it.
  // The input recorder at the bottom of this file uses _origAddEL so its own
  // listener registrations do NOT show up in the addEventListener trap log
  // (which would pollute the diff with our instrumentation's signatures).
  const _origAddEL = EventTarget.prototype.addEventListener;

  function stack() {
    try {
      const s = new Error().stack || '';
      const lines = s.split('\n').slice(2);
      for (const l of lines) {
        if (!l.includes('__inst') && !l.includes('native code')) return l.trim().slice(0, 180);
      }
      return lines[0] ? lines[0].trim().slice(0, 180) : '';
    } catch { return ''; }
  }

  function logAccess(obj, prop, val) {
    try {
      let vs = '';
      const vt = typeof val;
      if (val === null) vs = 'null';
      else if (vt === 'undefined') vs = 'undefined';
      else if (vt === 'function') vs = 'function';
      else if (vt === 'object') { try { vs = JSON.stringify(val).slice(0, 200); } catch { vs = '[object]'; } }
      else vs = String(val).slice(0, 200);
      logs.push({ t: performance.now(), o: obj, p: prop, vt, vs, s: stack() });
      if (logs.length > 20000) logs.shift();
    } catch {}
  }

  function wrap(target, name) {
    try {
      const proto = Object.getPrototypeOf(target);
      const descs = Object.getOwnPropertyDescriptors(proto);
      for (const [prop, desc] of Object.entries(descs)) {
        if (!desc.configurable) continue;
        if (prop === 'constructor') continue;
        if (!desc.get) continue;
        const origGet = desc.get;
        try {
          Object.defineProperty(proto, prop, {
            configurable: true, enumerable: desc.enumerable,
            get: function() { const v = origGet.call(this); logAccess(name, prop, v); return v; },
            set: desc.set,
          });
        } catch {}
      }
    } catch (e) { logs.push({ t: performance.now(), o: name, p: '<wrap-error>', vt: 'string', vs: String(e).slice(0, 120), s: '' }); }
  }

  wrap(navigator, 'navigator');
  wrap(screen, 'screen');
  wrap(document, 'document');
  try { wrap(document.documentElement, 'documentElement'); } catch {}
  try { wrap(window, 'window'); } catch {}
  try { wrap(performance, 'performance'); } catch {}
  try { wrap(location, 'location'); } catch {}
  try { wrap(history, 'history'); } catch {}

  const origGetParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    const v = origGetParam.apply(this, arguments); logAccess('WebGL', '0x' + (p || 0).toString(16), v); return v;
  };
  try {
    const origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(p) {
      const v = origGetParam2.apply(this, arguments); logAccess('WebGL2', '0x' + (p || 0).toString(16), v); return v;
    };
  } catch {}

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    const v = origToDataURL.apply(this, arguments); logAccess('Canvas', 'toDataURL', 'len=' + (v ? v.length : 0)); return v;
  };
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function() {
    const v = origGetImageData.apply(this, arguments); logAccess('Canvas', 'getImageData', 'len=' + (v?.data?.length || 0)); return v;
  };

  try {
    const origCreateOsc = OfflineAudioContext.prototype.createOscillator;
    OfflineAudioContext.prototype.createOscillator = function() {
      logAccess('OfflineAudioContext', 'createOscillator', ''); return origCreateOsc.apply(this, arguments);
    };
  } catch {}

  try {
    const origGetEntries = Performance.prototype.getEntriesByType;
    Performance.prototype.getEntriesByType = function(t) {
      const v = origGetEntries.apply(this, arguments); logAccess('Performance', 'getEntriesByType:' + t, 'n=' + (v?.length || 0)); return v;
    };
  } catch {}

  try {
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k, v) { logAccess('Storage', 'setItem:' + k, (v + '').slice(0, 80)); return origSetItem.apply(this, arguments); };
    const origGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(k) { const r = origGetItem.apply(this, arguments); logAccess('Storage', 'getItem:' + k, r === null ? 'null' : (r + '').slice(0, 80)); return r; };
  } catch {}

  try {
    if (navigator.permissions) {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(desc) { logAccess('Permissions', 'query:' + (desc?.name || '?'), ''); return origQuery(desc); };
    }
  } catch {}

  try {
    const origTS = Function.prototype.toString;
    Function.prototype.toString = function() {
      const r = origTS.apply(this, arguments); const name = (this && this.name) || '';
      if (name && name.length < 50) logAccess('Function', 'toString:' + name, r.slice(0, 80));
      return r;
    };
  } catch {}

  // MediaSource.isTypeSupported — TikTok HEVC detection pattern. Static method.
  try {
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) {
      const o = MediaSource.isTypeSupported;
      MediaSource.isTypeSupported = function(mime) { const r = o.call(this, mime); logAccess('MediaSource', 'isTypeSupported:' + String(mime).slice(0,80), String(r)); return r; };
    }
  } catch {}
  // HTMLMediaElement.canPlayType — same detection family.
  try {
    const o = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(mime) { const r = o.call(this, mime); logAccess('HTMLMediaElement', 'canPlayType:' + String(mime).slice(0,80), String(r)); return r; };
  } catch {}
  // mediaCapabilities.decodingInfo / encodingInfo — modern codec capability probe.
  try {
    if (navigator.mediaCapabilities) {
      for (const k of ['decodingInfo', 'encodingInfo']) {
        const o = navigator.mediaCapabilities[k];
        if (!o) continue;
        navigator.mediaCapabilities[k] = function(cfg) {
          let key = ''; try { key = JSON.stringify(cfg).slice(0, 120); } catch {}
          return o.call(this, cfg).then(r => { let v = ''; try { v = JSON.stringify(r).slice(0, 120); } catch {} logAccess('MediaCapabilities', k + ':' + key, v); return r; });
        };
      }
    }
  } catch {}
  // document.hasFocus() — bot often reports false when window is backgrounded.
  try {
    const o = Document.prototype.hasFocus;
    Document.prototype.hasFocus = function() { const r = o.call(this); logAccess('Document', 'hasFocus', String(r)); return r; };
  } catch {}
  // navigator.getBattery() — real devices return a BatteryManager, headless often not.
  try {
    if (typeof navigator.getBattery === 'function') {
      const o = navigator.getBattery.bind(navigator);
      navigator.getBattery = function() { return o().then(b => { let v = ''; try { v = JSON.stringify({ charging: b.charging, level: b.level }); } catch {} logAccess('Navigator', 'getBattery', v); return b; }); };
    }
  } catch {}
  // Date.prototype.getTimezoneOffset — persistent device property.
  try {
    const o = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() { const r = o.call(this); logAccess('Date', 'getTimezoneOffset', String(r)); return r; };
  } catch {}
  // Intl.DateTimeFormat().resolvedOptions().timeZone — locale/timezone fingerprint.
  try {
    const o = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function() { const r = o.call(this); logAccess('Intl.DateTimeFormat', 'resolvedOptions', r?.timeZone + '|' + r?.locale); return r; };
  } catch {}
  // navigator.mediaDevices.enumerateDevices — device enumeration fingerprint.
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const o = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = function() { return o().then(d => { logAccess('MediaDevices', 'enumerateDevices', 'n=' + (d?.length || 0)); return d; }); };
    }
  } catch {}
  // EventTarget.addEventListener — which events site listens to is a behavior signal.
  try {
    const o = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, opts) {
      logAccess('EventTarget', 'addEventListener:' + type, String(this?.constructor?.name || 'unknown'));
      return o.call(this, type, listener, opts);
    };
  } catch {}
  // PerformanceObserver.observe — site reading Event Timing API / navigation / resource.
  try {
    const o = PerformanceObserver.prototype.observe;
    PerformanceObserver.prototype.observe = function(opts) {
      let key = ''; try { key = JSON.stringify(opts).slice(0, 100); } catch {}
      logAccess('PerformanceObserver', 'observe', key);
      return o.call(this, opts);
    };
  } catch {}

  // SubtleCrypto.encrypt/decrypt — Arkose encrypts the fingerprint blob before
  // POSTing to /fc/gt2/public_key. Logging the plaintext here reveals what the
  // client fingerprint-collector serialised into the c= payload, without
  // needing to reverse the AES key derivation.
  try {
    if (crypto?.subtle?.encrypt) {
      const oEnc = crypto.subtle.encrypt.bind(crypto.subtle);
      crypto.subtle.encrypt = function(alg, key, data) {
        try {
          const name = (alg && (alg.name || alg)) + '';
          const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : (data?.buffer ? new Uint8Array(data.buffer) : new Uint8Array());
          const text = new TextDecoder('utf-8', { fatal: false }).decode(buf).slice(0, 50000);
          logs.push({ t: performance.now(), o: 'SubtleCrypto', p: 'encrypt:' + name, vt: 'string', vs: text, s: stack() });
        } catch {}
        return oEnc(alg, key, data);
      };
    }
  } catch {}
  // XMLHttpRequest — some clients bypass fetch for telemetry posts.
  try {
    const oOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) { try { logAccess('XHR', 'open:' + method, (url + '').slice(0, 120)); } catch {}; return oOpen.apply(this, arguments); };
    const oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) { try { logAccess('XHR', 'send', (typeof body === 'string' ? body : '[non-string]').slice(0, 600)); } catch {}; return oSend.apply(this, arguments); };
  } catch {}

  logs.push({ t: performance.now(), o: '_init_', p: 'done', vt: 'string', vs: 'ok', s: '' });

  // ===== INPUT EVENT RECORDER =====
  // Captures user-driven mouse / keyboard / wheel / scroll / visibility events
  // for human-vs-trajectory diffing. The property trap above logs that
  // addEventListener was *registered* for these types; this section logs the
  // actual events as they fire. Pushed into the same `logs` array so the
  // existing __inst_flush() picks them up — no separate flush channel needed.
  // Uses _origAddEL to bypass our own addEventListener wrap (so our listener
  // registrations don't pollute the addEventListener trap log).
  // Key text is redacted (printable single-char keys recorded as "_") so we
  // don't capture passwords or comment bodies; only timing + key code.
  try {
    function recI(type, fields) {
      let vs = '';
      try { vs = JSON.stringify(fields).slice(0, 200); } catch {}
      logs.push({ t: performance.now(), o: 'Input', p: type, vt: 'object', vs, s: '' });
      if (logs.length > 20000) logs.shift();
    }
    let lastMove = 0;
    const SAMPLE_MOVE_MS = 50; // ~20Hz
    _origAddEL.call(document, 'pointermove', function(ev) {
      const now = performance.now();
      if (now - lastMove < SAMPLE_MOVE_MS) return;
      lastMove = now;
      recI('pointermove', { x: ev.clientX, y: ev.clientY });
    }, { capture: true, passive: true });
    ['pointerdown','pointerup','click','dblclick','contextmenu'].forEach(function(t) {
      _origAddEL.call(document, t, function(ev) {
        recI(t, { x: ev.clientX, y: ev.clientY, btn: ev.button, tag: (ev.target && ev.target.tagName) || '' });
      }, { capture: true, passive: true });
    });
    ['keydown','keyup'].forEach(function(t) {
      _origAddEL.call(document, t, function(ev) {
        const k = ev.key || '';
        recI(t, { key: (k.length === 1 ? '_' : k), code: ev.code, mod: (ev.shiftKey?'S':'')+(ev.ctrlKey?'C':'')+(ev.metaKey?'M':'')+(ev.altKey?'A':'') });
      }, { capture: true, passive: true });
    });
    _origAddEL.call(document, 'wheel', function(ev) { recI('wheel', { dy: ev.deltaY, dx: ev.deltaX }); }, { capture: true, passive: true });
    _origAddEL.call(window, 'scroll', function() { recI('scroll', { sy: window.scrollY, sx: window.scrollX }); }, { capture: true, passive: true });
    _origAddEL.call(document, 'visibilitychange', function() { recI('visibilitychange', { s: document.visibilityState }); }, { capture: true, passive: true });
    _origAddEL.call(window, 'focus', function() { recI('focus', {}); }, { capture: true, passive: true });
    _origAddEL.call(window, 'blur', function() { recI('blur', {}); }, { capture: true, passive: true });
  } catch (e) {
    logs.push({ t: performance.now(), o: '_input_', p: '<init-error>', vt: 'string', vs: String(e).slice(0, 120), s: '' });
  }

  // ===== FETCH WRAP =====
  // Reddit's comment-submit goes through window.fetch (GraphQL POST). The XHR
  // wrap above misses it. Logs URL, method, body, and response status into the
  // same logs array so the diff can compare comment-submit POST shape across
  // sessions (post id, request token, csrf, persona-bound IDs, etc.).
  try {
    const oFetch = window.fetch;
    window.fetch = function(input, init) {
      let url = '', method = 'GET', body = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input && typeof input === 'object') { url = input.url || ''; method = input.method || 'GET'; }
        if (init) {
          if (init.method) method = init.method;
          const b = init.body;
          if (typeof b === 'string') body = b.slice(0, 4000);
          else if (b instanceof URLSearchParams) body = b.toString().slice(0, 4000);
          else if (typeof FormData !== 'undefined' && b instanceof FormData) body = '[FormData]';
          else if (b && b.byteLength != null) body = '[binary len=' + b.byteLength + ']';
        }
      } catch {}
      logAccess('Fetch', String(method).toUpperCase() + ':' + url.slice(0, 200), body);
      return oFetch.apply(this, arguments).then(function(r) {
        try { logAccess('Fetch', 'res:' + url.slice(0, 200), 'status=' + r.status); } catch {}
        return r;
      });
    };
  } catch (e) {
    logs.push({ t: performance.now(), o: '_fetch_', p: '<init-error>', vt: 'string', vs: String(e).slice(0, 120), s: '' });
  }
})();
