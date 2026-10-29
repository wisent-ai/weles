// Navigator surface stubs: the HEVC decode shim and the API surfaces a real
// Chrome exposes that the patched build does not, defined from __weles the
// way navigator.js defines the core properties. Loaded right after
// navigator.js by src/page-init/loader.ts; both read the same __weles.

// --- HEVC codec support shim ---
// Chromium (weles's base) does not ship HEVC — only Google Chrome's proprietary
// build includes it. TikTok runs `MediaCapabilities.decodingInfo({video:{
// contentType:'video/mp4; codecs="hev1.1.6.L93.B0"'}})` during signup and
// observes `supported:false` on weles but `supported:true` on real Chrome 147
// on Mac. Cached as `hevc_support_key_v4=0` in localStorage, which webmssdk
// signs into x-mssdk-info. Spoof HEVC as supported to match real Chrome.
// Measured side-by-side on the same Mac.

(function installHevcShim() {
  try {
    const isHevc = (s) => /\b(hev1|hvc1)\b/i.test(s || '');

    const regNS = window.__welesNativeString;
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) {
      const orig = MediaSource.isTypeSupported.bind(MediaSource);
      const its = function (type) {
        if (isHevc(type)) return true;
        return orig(type);
      };
      if (regNS) regNS(its, 'isTypeSupported');
      MediaSource.isTypeSupported = its;
    }

    if (
      typeof HTMLMediaElement !== 'undefined' &&
      HTMLMediaElement.prototype.canPlayType
    ) {
      const origCpt = HTMLMediaElement.prototype.canPlayType;
      const cpt = function (type) {
        if (isHevc(type)) return 'probably';
        return origCpt.call(this, type);
      };
      if (regNS) regNS(cpt, 'canPlayType');
      HTMLMediaElement.prototype.canPlayType = cpt;
    }

    if (
      navigator.mediaCapabilities &&
      navigator.mediaCapabilities.decodingInfo
    ) {
      const origDec = navigator.mediaCapabilities.decodingInfo.bind(
        navigator.mediaCapabilities,
      );
      const di = function (config) {
        try {
          const ct =
            config?.video?.contentType || config?.audio?.contentType || '';
          if (isHevc(ct)) {
            return Promise.resolve({
              supported: true,
              smooth: true,
              powerEfficient: true,
              configuration: config,
            });
          }
        } catch {}
        return origDec(config);
      };
      if (regNS) regNS(di, 'decodingInfo');
      navigator.mediaCapabilities.decodingInfo = di;
    }
  } catch {}
})();

// --- OS-consistent navigator surface stubs ---
// ReCAPTCHA Enterprise / PerimeterX probe many navigator APIs beyond the
// basic UA/screen/webgl. If the host OS differs from the persona OS, the
// real host leaks through these surfaces. Stub them to match the target OS.
(function installNavigatorSurfaceStubs() {
  try {
    const nav = __weles.navigator;
    const targetOs = (nav.platform || '').toLowerCase().includes('mac')
      ? 'macos'
      : (nav.platform || '').toLowerCase().includes('win')
        ? 'windows'
        : 'linux';
    const regNS = window.__welesNativeString;

    // 1. speechSynthesis.getVoices — the host OS leaks HARD here (macOS voices
    // are identifiable by the com.apple.* voiceURI). Return a small, realistic
    // list matching the target OS.
    (function stubSpeechVoices() {
      if (typeof window === 'undefined' || !window.speechSynthesis) return;
      const baseVoice = (name, lang, local = true) => ({
        name,
        lang,
        default:
          name === 'Samantha' ||
          name === 'Microsoft David' ||
          name === 'Default',
        localService: local,
        voiceURI: name,
      });
      const voicesByOs = {
        macos: [
          baseVoice('Samantha', 'en-US'),
          baseVoice('Alex', 'en-US'),
          baseVoice('Daniel', 'en-GB'),
          baseVoice('Fiona', 'en-scotland'),
          baseVoice('Karen', 'en-AU'),
          baseVoice('Moira', 'en-IE'),
          baseVoice('Tessa', 'en-ZA'),
          baseVoice('Veena', 'en-IN'),
          baseVoice('Fred', 'en-US'),
          baseVoice('Vicki', 'en-US'),
        ],
        windows: [
          baseVoice('Microsoft David', 'en-US'),
          baseVoice('Microsoft Zira', 'en-US'),
          baseVoice('Microsoft Mark', 'en-US'),
          baseVoice('Microsoft David Desktop', 'en-US'),
          baseVoice('Microsoft Zira Desktop', 'en-US'),
        ],
        linux: [
          baseVoice('English', 'en-US'),
          baseVoice('English (Great Britain)', 'en-GB'),
        ],
      };
      const voices = voicesByOs[targetOs] || voicesByOs.linux;
      const getVoices = function () {
        return voices;
      };
      if (regNS) regNS(getVoices, 'getVoices');
      try {
        Object.defineProperty(window.speechSynthesis, 'getVoices', {
          value: getVoices,
          configurable: true,
          enumerable: true,
        });
      } catch {}
    })();

    // 2. navigator.mediaDevices — real Firefox/Chrome expose a MediaDevices
    // object with getUserMedia/enumerateDevices. Weles currently leaves it as
    // an empty {} on Firefox, which is a bot tell.
    (function stubMediaDevices() {
      if (typeof navigator === 'undefined') return;
      if (
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function' &&
        typeof navigator.mediaDevices.enumerateDevices === 'function'
      )
        return;
      try {
        const devices = Object.create(
          typeof MediaDevices !== 'undefined'
            ? MediaDevices.prototype
            : Object.prototype,
        );
        const noop = function () {
          return Promise.reject(
            new DOMException('Permission denied', 'NotAllowedError'),
          );
        };
        // Real Chrome always exposes at least default audio + a video input even
        // before permission. Empty list is a headless/container tell.
        const defaultDevices = [
          {
            deviceId: 'default',
            kind: 'audioinput',
            label: '',
            groupId: 'default',
          },
          {
            deviceId: 'communications',
            kind: 'audioinput',
            label: '',
            groupId: 'communications',
          },
          {
            deviceId: 'default',
            kind: 'audiooutput',
            label: '',
            groupId: 'default',
          },
          {
            deviceId: 'communications',
            kind: 'audiooutput',
            label: '',
            groupId: 'communications',
          },
          { deviceId: '', kind: 'videoinput', label: '', groupId: '' },
        ];
        Object.defineProperties(devices, {
          getUserMedia: { value: noop, configurable: true, enumerable: true },
          enumerateDevices: {
            value: function () {
              return Promise.resolve(defaultDevices);
            },
            configurable: true,
            enumerable: true,
          },
          getSupportedConstraints: {
            value: function () {
              return {};
            },
            configurable: true,
            enumerable: true,
          },
          addEventListener: {
            value: function () {},
            configurable: true,
            enumerable: true,
          },
          removeEventListener: {
            value: function () {},
            configurable: true,
            enumerable: true,
          },
        });
        const getDevices = function () {
          return devices;
        };
        if (regNS) regNS(getDevices, 'get mediaDevices');
        // Define on Navigator.prototype so it shadows any native getter; defining
        // on the navigator instance can fail if the property is non-configurable
        // (observed on weles Firefox).
        Object.defineProperty(Navigator.prototype, 'mediaDevices', {
          get: getDevices,
          configurable: true,
          enumerable: true,
        });
        // Also set on the current navigator instance as a fallback.
        try {
          Object.defineProperty(navigator, 'mediaDevices', {
            get: getDevices,
            configurable: true,
            enumerable: true,
          });
        } catch (_) {}
      } catch {
        /* leave native mediaDevices */
      }
    })();
  } catch {}
})();
