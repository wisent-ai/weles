// Minimal screen + WebRTC patch for the custom Chromium path. Loaded separately
// so these protections run even if the larger navigator.js stub fails on a
// particular page.

(function applyScreenPatch() {
  const scr = __weles && __weles.screen;
  if (!scr) return;
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
    Object.defineProperty(window, 'screen', {
      get: function() { return screenProxy; },
      configurable: true,
      enumerable: true,
    });
  } catch (screenErr) {
    try {
      for (const [prop, val] of Object.entries(scr)) {
        if (val !== undefined) {
          Object.defineProperty(Screen.prototype, prop, {
            get: function() { return val; },
            configurable: true,
            enumerable: true,
          });
        }
      }
    } catch {}
  }
})();

(function blockWebRTCLeak() {
  if (typeof RTCPeerConnection === 'undefined') return;
  try {
    const Original = RTCPeerConnection;
    const stripHostSrflx = function(sdp) {
      if (typeof sdp !== 'string') return sdp;
      return sdp.replace(/a=candidate:[^\r\n]+\s+(host|srflx)[^\r\n]*(?:\r\n|\n)/g, '');
    };
    function RTCPeerConnectionShim(configuration) {
      const pc = new Original(configuration);
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
      const origSetLocal = pc.setLocalDescription.bind(pc);
      pc.setLocalDescription = function(desc) {
        if (desc && typeof desc.sdp === 'string') desc.sdp = stripHostSrflx(desc.sdp);
        return origSetLocal(desc);
      };
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
    Object.defineProperty(window, 'RTCPeerConnection', {
      value: RTCPeerConnectionShim,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  } catch (e) { /* leave native WebRTC */ }
})();
