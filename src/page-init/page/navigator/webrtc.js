// The WebRTC leak guard, loaded once on every launch path by
// src/page-init/loader.ts. Real Chrome exposes RTCPeerConnection, but on a
// proxied run STUN hands the page the machine's local and public addresses.
// The API stays present (removing it is a bot tell); every candidate except a
// relayed one is stripped from the SDP and icecandidate events are suppressed.
// A shim that cannot install itself says so under the marker Weles reads
// (src/page-init/failures.ts), which closes the page rather than let it run
// with native WebRTC.

(function blockWebRTCLeak() {
  if (typeof RTCPeerConnection === 'undefined') return;
  try {
    const Original = RTCPeerConnection;
    // An SDP candidate line names its type after the word "typ"
    // (https://www.rfc-editor.org/rfc/rfc8839#section-5.1). Only a relayed
    // candidate carries the TURN server's address instead of this machine's.
    const relayedOnly = function (line) {
      if (!line.startsWith('a=candidate:')) return true;
      const named = /\styp\s+(?<type>\S+)/.exec(line);
      return named !== null && named.groups.type === 'relay';
    };
    const stripLocalCandidates = function (sdp) {
      if (typeof sdp !== 'string') return sdp;
      return sdp
        .split(/(?<=\n)/)
        .filter((line) => relayedOnly(line.trim()))
        .join('');
    };
    function RTCPeerConnectionShim(configuration) {
      const pc = new Original(configuration);
      // Filter createOffer/createAnswer SDP before it reaches the page.
      const wrap = function (orig) {
        return function () {
          const p = orig.apply(pc, arguments);
          return p.then(function (desc) {
            if (desc && typeof desc.sdp === 'string')
              desc.sdp = stripLocalCandidates(desc.sdp);
            return desc;
          });
        };
      };
      pc.createOffer = wrap(pc.createOffer.bind(pc));
      pc.createAnswer = wrap(pc.createAnswer.bind(pc));
      // Filter manually-set local descriptions too.
      const origSetLocal = pc.setLocalDescription.bind(pc);
      pc.setLocalDescription = function (desc) {
        if (desc && typeof desc.sdp === 'string')
          desc.sdp = stripLocalCandidates(desc.sdp);
        return origSetLocal(desc);
      };
      // Suppress icecandidate events: they carry the leaked addresses.
      const origAddEventListener = pc.addEventListener.bind(pc);
      pc.addEventListener = function (type, listener, options) {
        if (type === 'icecandidate') return undefined;
        return origAddEventListener(type, listener, options);
      };
      let userOnIceCandidate = null;
      Object.defineProperty(pc, 'onicecandidate', {
        get: function () {
          return userOnIceCandidate;
        },
        set: function (fn) {
          userOnIceCandidate = typeof fn === 'function' ? fn : null;
        },
        configurable: true,
        enumerable: true,
      });
      return pc;
    }
    RTCPeerConnectionShim.prototype = Original.prototype;
    if (window.__welesNativeString)
      window.__welesNativeString(RTCPeerConnectionShim, 'RTCPeerConnection');
    Object.defineProperty(window, 'RTCPeerConnection', {
      value: RTCPeerConnectionShim,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  } catch (error) {
    console.debug(
      '__weles_page_init_failure__',
      JSON.stringify({
        patch: 'webrtc',
        error: String((error && error.message) || error),
      }),
    );
  }
})();
