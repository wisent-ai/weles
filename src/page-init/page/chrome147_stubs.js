// Stub the 5 top-level Web API constructors that Chromium 147 exposes but
// weles (Chromium 145) doesn't. Anti-bot SDKs (TikTok mssdk, BotD derivatives)
// check `typeof window.Sanitizer !== 'undefined'` to distinguish old Chrome.
// Adding these alone does NOT close the full 300-property gap from 146/147,
// but it addresses the highest-visibility named globals that are trivial to
// check from JS. Keep this SURGICAL — no prototype overrides, no Navigator
// touching, no behavioral shims — so it doesn't re-trigger the regression
// we saw when enabling the full navigator.js spoof stack on custom binary.

(function installChrome147Stubs() {
  try {
    if (typeof window.Sanitizer === 'undefined') {
      class Sanitizer {
        constructor(config) { this._cfg = config; }
        sanitize() { return null; }
        sanitizeFor() { return null; }
        static getDefaultConfiguration() { return {}; }
      }
      Object.defineProperty(window, 'Sanitizer', { value: Sanitizer, writable: true, configurable: true });
    }
    if (typeof window.AnimationTrigger === 'undefined') {
      class AnimationTrigger { constructor(opts) { Object.assign(this, opts ?? {}); } }
      Object.defineProperty(window, 'AnimationTrigger', { value: AnimationTrigger, writable: true, configurable: true });
    }
    if (typeof window.TimelineTrigger === 'undefined') {
      class TimelineTrigger {}
      Object.defineProperty(window, 'TimelineTrigger', { value: TimelineTrigger, writable: true, configurable: true });
    }
    if (typeof window.TimelineTriggerRange === 'undefined') {
      class TimelineTriggerRange {}
      Object.defineProperty(window, 'TimelineTriggerRange', { value: TimelineTriggerRange, writable: true, configurable: true });
    }
    if (typeof window.TimelineTriggerRangeList === 'undefined') {
      class TimelineTriggerRangeList {}
      Object.defineProperty(window, 'TimelineTriggerRangeList', { value: TimelineTriggerRangeList, writable: true, configurable: true });
    }
  } catch {}
})();

// Proprietary codec support shim. Chromium open-source builds compile with
// proprietary_codecs=false and ship without h264 (avc1), h265/HEVC (hev1/hvc1),
// AAC, MP3, AC3 — codecs that ARE present in Google Chrome's official binary
// (which sets proprietary_codecs=true + ffmpeg_branding=Chrome). TikTok's
// webmssdk probes these via MediaSource.isTypeSupported, HTMLMediaElement
// .canPlayType, and MediaCapabilities.decodingInfo, then signs the answers
// into x-mssdk-info. A weles session reports false for ALL of these where
// real Chrome reports true — a perfect "not Google Chrome" signal stable
// across every fingerprint variant. Spoof support to match Chrome.
// Measured 2026-04-18 side-by-side via instrument.mjs (h264_ms=false on
// weles, true on real Chrome 147 Mac).
(function installCodecShim() {
  try {
    // Whitelist of codec-family patterns Google Chrome supports that vanilla
    // Chromium refuses. Match only well-formed codec tokens, NOT arbitrary
    // strings containing a substring — otherwise fake codec "fake1.999"
    // returns true and creates a new fingerprint tell vs real Chrome.
    var CODEC_TOKEN_RE = /\bcodecs="?([a-z0-9.,\s-]+)"?/i;
    var KNOWN_PROP = [
      /^avc1\.[0-9a-f]{6}$/i,        // H.264 with profile/level
      /^avc3\.[0-9a-f]{6}$/i,
      /^hev1\.\d+\.\d+\.[a-z]\d+\.[a-z0-9]+$/i,  // HEVC
      /^hvc1\.\d+\.\d+\.[a-z]\d+\.[a-z0-9]+$/i,
      /^mp4a\.\d+(\.\d+)?$/i,        // AAC variants
      /^mp3$/i,
      /^ac-3$/i,
      /^ec-3$/i,
    ];
    var isProp = function(s) {
      if (!s) return false;
      var m = CODEC_TOKEN_RE.exec(s);
      if (!m) {
        // Bare "audio/mpeg" has no codecs= param in Chrome — real Chrome
        // returns true for this MIME alone.
        return /^\s*audio\/mpeg\s*$/i.test(s);
      }
      var tokens = m[1].split(',').map(function(t) { return t.trim(); });
      for (var i = 0; i < tokens.length; i++) {
        var matched = false;
        for (var j = 0; j < KNOWN_PROP.length; j++) {
          if (KNOWN_PROP[j].test(tokens[i])) { matched = true; break; }
        }
        if (!matched) return false;
      }
      return tokens.length > 0;
    };

    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) {
      var origIts = MediaSource.isTypeSupported.bind(MediaSource);
      MediaSource.isTypeSupported = function(type) {
        if (origIts(type)) return true;
        if (isProp(type)) return true;
        return false;
      };
    }

    if (typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype.canPlayType) {
      var origCpt = HTMLMediaElement.prototype.canPlayType;
      // Arkose's audio_codecs fingerprint probes bare MIMEs (audio/mp4, audio/aac)
      // where Chrome returns "maybe"/"probably" across all platforms even without
      // specific codecs= param. Open-source Chromium without proprietary ffmpeg
      // branding returns "" for these, which differs from Chrome and shows up in
      // the Arkose bda payload as audio_codecs{m4a:"",aac:""} instead of
      // {m4a:"maybe",aac:"probably"}.
      var BARE_MIME_MAP = { 'audio/mp4': 'maybe', 'audio/x-m4a': 'maybe', 'audio/aac': 'probably', 'audio/mpeg': 'probably' };
      HTMLMediaElement.prototype.canPlayType = function(type) {
        var r = origCpt.call(this, type);
        if (r) return r;
        var trimmed = (type + '').trim().toLowerCase();
        if (BARE_MIME_MAP[trimmed]) return BARE_MIME_MAP[trimmed];
        if (isProp(type)) return 'probably';
        return '';
      };
    }

    if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
      var origDec = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
      navigator.mediaCapabilities.decodingInfo = function(config) {
        try {
          var ct = (config && config.video && config.video.contentType) ||
                   (config && config.audio && config.audio.contentType) || '';
          if (isProp(ct)) {
            return Promise.resolve({
              supported: true,
              smooth: true,
              powerEfficient: true,
              configuration: config,
            });
          }
        } catch (e) {}
        return origDec(config);
      };
    }
  } catch {}
})();
