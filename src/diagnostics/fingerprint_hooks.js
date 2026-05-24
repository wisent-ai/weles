// Fingerprint-surface hooks PerimeterX reads but property_trap.js does not
// log the value of. Three groups:
//   1) Canvas pixel-hash: HTMLCanvasElement.toDataURL +
//      CanvasRenderingContext2D.getImageData logged as FNV-1a 32-bit hash +
//      first 80 chars + length, so the actual discriminator is visible
//      without dumping 500KB per call.
//   2) Audio render output: OfflineAudioContext.startRendering +
//      AudioBuffer.getChannelData logged with sample length, sum of first
//      1k abs values, and a hash of first 200 samples.
//   3) Window-level webdriver/automation flags: install instance-level
//      getters on `window` for known PerimeterX-checked names so plain
//      `window.X` reads are logged.
// Pushes into window.__inst installed by property_trap.js.
(function(){
  if (!window.__inst || window.__inst_fp_installed) return;
  window.__inst_fp_installed = true;
  const logs = window.__inst;
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

  // (1) Canvas content hash.
  try {
    const oToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function() {
      const v = oToDataURL.apply(this, arguments);
      logAccess('Canvas', 'toDataURL', 'len=' + (v ? v.length : 0) + ' h=' + (v ? _fnv32(v) : '0') + ' head=' + (v ? v.slice(0, 80) : ''));
      return v;
    };
    const oGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function() {
      const v = oGetImageData.apply(this, arguments);
      const d = v && v.data;
      logAccess('Canvas', 'getImageData', 'len=' + (d ? d.length : 0) + ' h=' + (d ? _fnv32u8(d) : '0'));
      return v;
    };
  } catch (e) { logAccess('_fp_', 'canvas-init-error', String(e).slice(0, 120)); }

  // (2) Audio render output hash.
  try {
    if (typeof OfflineAudioContext !== 'undefined') {
      const oStart = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function() {
        const p = oStart.apply(this, arguments);
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
      };
    }
    if (typeof AudioBuffer !== 'undefined') {
      const oGetCh = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function(c) {
        const r = oGetCh.apply(this, arguments);
        try {
          const first = [];
          for (let i = 0; i < Math.min(r.length, 10); i++) first.push(r[i].toFixed(8));
          logAccess('AudioBuffer', 'getChannelData:' + c, 'len=' + r.length + ' first10=' + first.join(','));
        } catch (err) { logAccess('_fp_', 'getChannelData-error', String(err).slice(0, 120)); }
        return r;
      };
    }
  } catch (e) { logAccess('_fp_', 'audio-init-error', String(e).slice(0, 120)); }

  // (3) Window-level webdriver/automation flag instance getters. These
  // properties aren't on Window.prototype as configurable getters; they
  // are read as plain window.X. Install per-flag instance getters so any
  // read is logged. Preserve the value the page might later set.
  try {
    const FLAG_BLOB = '__webdriver_script_fn|__webdriver_evaluate|__selenium_evaluate|__fxdriver_evaluate|__driver_unwrapped|__webdriver_unwrapped|__selenium_unwrapped|__fxdriver_unwrapped|__lastWatirAlert|__lastWatirConfirm|__lastWatirPrompt|domAutomation|domAutomationController|_phantom|callPhantom|__nightmare|_Selenium_IDE_Recorder';
    const winFlags = FLAG_BLOB.split('|');
    for (let i = 0; i < winFlags.length; i++) {
      const k = winFlags[i];
      try {
        const cur = Object.getOwnPropertyDescriptor(window, k);
        if (cur && cur.configurable === false) continue;
        let val = window[k];
        Object.defineProperty(window, k, {
          configurable: true,
          get: function() { logAccess('window-flag', k, val === undefined ? 'undefined' : (val + '').slice(0, 80)); return val; },
          set: function(v) { val = v; },
        });
      } catch (err) { logAccess('_fp_', 'win-flag-init:' + k, String(err).slice(0, 80)); }
    }
    try {
      if (window.chrome && window.chrome.runtime) {
        const origId = window.chrome.runtime.id;
        Object.defineProperty(window.chrome.runtime, 'id', {
          configurable: true,
          get: function() { logAccess('chrome.runtime', 'id', origId === undefined ? 'undefined' : (origId + '').slice(0, 80)); return origId; },
        });
      }
    } catch (err) { logAccess('_fp_', 'chrome-runtime-init', String(err).slice(0, 80)); }
  } catch (e) { logAccess('_fp_', 'win-flags-init-error', String(e).slice(0, 120)); }

  // WebRTC ICE candidate exposure: PX's main.min.js references RTCPeerConnection.
  // Log every createOffer SDP, setLocalDescription SDP, and onicecandidate event
  // payload so the local/remote candidate strings (which can reveal host LAN IP)
  // are captured rather than hidden inside opaque RTCSessionDescription objects.
  try {
    if (typeof RTCPeerConnection !== 'undefined') {
      const oCreate = RTCPeerConnection.prototype.createOffer;
      RTCPeerConnection.prototype.createOffer = function() {
        const me = this;
        const p = oCreate.apply(this, arguments);
        return p.then(function(desc) { try { logAccess('RTCPeerConnection', 'createOffer', (desc && desc.sdp ? desc.sdp.slice(0, 4000) : 'no-sdp')); } catch {} return desc; });
      };
      const oSet = RTCPeerConnection.prototype.setLocalDescription;
      RTCPeerConnection.prototype.setLocalDescription = function(desc) {
        try { logAccess('RTCPeerConnection', 'setLocalDescription', (desc && desc.sdp ? desc.sdp.slice(0, 4000) : 'no-sdp')); } catch {}
        return oSet.apply(this, arguments);
      };
      const oAdd = RTCPeerConnection.prototype.addIceCandidate;
      RTCPeerConnection.prototype.addIceCandidate = function(cand) {
        try { logAccess('RTCPeerConnection', 'addIceCandidate', (cand && cand.candidate ? cand.candidate.slice(0, 400) : (cand + '').slice(0, 400))); } catch {}
        return oAdd.apply(this, arguments);
      };
    }
  } catch (e) { logAccess('_fp_', 'rtc-init-error', String(e).slice(0, 120)); }

  // Function.prototype.toString — PX uses this to detect patched natives.
  // property_trap already wraps it but truncates to first 80 chars of the
  // returned source. Widen to full return on the natives PX is most likely
  // to inspect: navigator getters and Object wrappers.
  try {
    const wantedNames = new Set('getParameter|toDataURL|getImageData|getChannelData|startRendering|addEventListener|createOffer|setLocalDescription|getBattery|enumerateDevices|requestAnimationFrame|setTimeout|fetch|XMLHttpRequest|defineProperty|getOwnPropertyDescriptor|hasOwnProperty'.split('|'));
    const oTS = Function.prototype.toString;
    const wrap = function() {
      const r = oTS.apply(this, arguments);
      try {
        const name = (this && this.name) || '';
        if (wantedNames.has(name)) {
          logAccess('Function-full', 'toString:' + name, r.slice(0, 600));
        }
      } catch {}
      return r;
    };
    // Replace only if property_trap's wrapper is currently active (its hook
    // logs short strings under 'Function.toString'). Stack on top of it.
    Function.prototype.toString = wrap;
  } catch (e) { logAccess('_fp_', 'fn-tostring-init-error', String(e).slice(0, 120)); }

  logs.push({ t: performance.now(), o: '_fp_init_', p: 'done', vt: 'string', vs: 'ok', s: '' });
})();
