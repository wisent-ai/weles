// Environment signals beyond the navigator surface: the WebRTC leak guard,
// timezone, plugins, connection, Bluetooth and keyboard presence, and the
// Intl locale. Loaded right after navigator.js by src/page-init/loader.ts;
// both read the same __weles and the same window.__welesDefine helper.

// --- WebRTC IP-leak mitigation ---
// Real Chrome exposes RTCPeerConnection, but on a proxied/automation run STUN
// can leak the local network IP and sometimes bypass the proxy. We keep the
// API present (removing it is a bot tell) but strip host/srflx candidates from
// the SDP and suppress icecandidate events so the probe/anti-bot sees no IPs.
(function blockWebRTCLeak() {
  if (typeof RTCPeerConnection === 'undefined') return;
  try {
    const Original = RTCPeerConnection;
    const stripHostSrflx = function(sdp) {
      if (typeof sdp !== 'string') return sdp;
      // Remove host and server-reflexive (srflx) candidates. Leave relay/TURN.
      return sdp.replace(/a=candidate:[^\r\n]+\s+(host|srflx)[^\r\n]*(?:\r\n|\n)/g, '');
    };
    function RTCPeerConnectionShim(configuration) {
      const pc = new Original(configuration);
      // Filter createOffer/createAnswer SDP before it reaches the page.
      const wrap = function(orig) {
        return function() {
          const p = orig.apply(pc, arguments);
          return p.then(function(desc) {
            if (desc && typeof desc.sdp === 'string') desc.sdp = stripHostSrflx(desc.sdp);
            return desc;
          });
        };
      };
      pc.createOffer = wrap(pc.createOffer.bind(pc));
      pc.createAnswer = wrap(pc.createAnswer.bind(pc));
      // Filter manually-set local descriptions too.
      const origSetLocal = pc.setLocalDescription.bind(pc);
      pc.setLocalDescription = function(desc) {
        if (desc && typeof desc.sdp === 'string') desc.sdp = stripHostSrflx(desc.sdp);
        return origSetLocal(desc);
      };
      // Suppress icecandidate events — they carry the leaked addresses.
      const origAddEventListener = pc.addEventListener.bind(pc);
      pc.addEventListener = function(type, listener, options) {
        if (type === 'icecandidate') return undefined;
        return origAddEventListener(type, listener, options);
      };
      let userOnIceCandidate = null;
      Object.defineProperty(pc, 'onicecandidate', {
        get: function() { return userOnIceCandidate; },
        set: function(fn) { userOnIceCandidate = (typeof fn === 'function' ? fn : null); },
        configurable: true,
        enumerable: true,
      });
      return pc;
    }
    RTCPeerConnectionShim.prototype = Original.prototype;
    if (window.__welesNativeString) window.__welesNativeString(RTCPeerConnectionShim, 'RTCPeerConnection');
    Object.defineProperty(window, 'RTCPeerConnection', { value: RTCPeerConnectionShim, configurable: true, writable: true, enumerable: true });
  } catch (e) { /* leave native WebRTC */ }
})();

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
  try {
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
  } catch { /* leave native bluetooth/keyboard */ }
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
