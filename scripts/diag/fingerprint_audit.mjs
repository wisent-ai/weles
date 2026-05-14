/**
 * Fingerprint audit: launch weles Chromium with the same persona that fresh
 * Reddit signups use, then dump every signal Reddit's anti-bot is likely to
 * read. Compare the persona's *claimed* values against what the browser
 * actually exposes — any mismatch is a fingerprint tell.
 */
import { WSession } from '../../dist/session/wsession.js';

const s = await WSession.start({ label: 'fp_audit', browser: 'chromium' });

await s.page.goto('https://www.example.com', { waitUntil: 'domcontentloaded' });

const audit = await s.page.evaluate(async () => {
  function safe(fn, fallback = null) { try { return fn(); } catch { return fallback; } }
  const out = {};
  out.userAgent = navigator.userAgent;
  out.appVersion = navigator.appVersion;
  out.platform = navigator.platform;
  out.language = navigator.language;
  out.languages = JSON.stringify(navigator.languages);
  out.hardwareConcurrency = navigator.hardwareConcurrency;
  out.deviceMemory = navigator.deviceMemory;
  out.vendor = navigator.vendor;
  out.product = navigator.product;
  out.productSub = navigator.productSub;
  out.cookieEnabled = navigator.cookieEnabled;
  out.maxTouchPoints = navigator.maxTouchPoints;
  out.webdriver = navigator.webdriver;
  out.doNotTrack = navigator.doNotTrack;
  out.plugins_count = navigator.plugins.length;
  out.plugin_names = Array.from(navigator.plugins).map(p => p.name);
  out.mimeTypes_count = navigator.mimeTypes.length;
  out.mimeType_names = Array.from(navigator.mimeTypes).map(m => m.type);
  out.connection = safe(() => JSON.stringify({
    effectiveType: navigator.connection?.effectiveType,
    rtt: navigator.connection?.rtt,
    downlink: navigator.connection?.downlink,
    saveData: navigator.connection?.saveData,
  }));
  out.permissions_notifications = await safe(async () => {
    const p = await navigator.permissions.query({ name: 'notifications' });
    return p.state;
  });
  out.battery = await safe(async () => {
    const b = await navigator.getBattery();
    return JSON.stringify({ charging: b.charging, level: b.level });
  });

  out.screen = JSON.stringify({
    w: screen.width, h: screen.height,
    aw: screen.availWidth, ah: screen.availHeight,
    cd: screen.colorDepth, pd: screen.pixelDepth,
    dpr: window.devicePixelRatio,
    inner: { w: innerWidth, h: innerHeight },
    outer: { w: outerWidth, h: outerHeight },
  });

  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.timezoneOffset = new Date().getTimezoneOffset();

  // WebGL — the canonical anti-bot signal. The renderer/vendor must match
  // the claimed persona OS. Mismatch = automation.
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (gl) {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    out.webgl_vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    out.webgl_renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    out.webgl_version = gl.getParameter(gl.VERSION);
    out.webgl_shading_language = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
    out.webgl_max_texture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.webgl_extensions = gl.getSupportedExtensions().slice(0, 5).join(',');
  }

  // AudioContext — system sample rate (not forced via Offline ctor)
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    out.audio_sampleRate = ac.sampleRate;
    out.audio_destChannels = ac.destination.channelCount;
    out.audio_baseLatency = ac.baseLatency;
    out.audio_outputLatency = ac.outputLatency;
    ac.close();
  } catch (e) { out.audio_err = e.message; }
  // OfflineAudioContext — anti-bots fingerprint this too
  try {
    const oac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
    out.offline_audio_sampleRate = oac.sampleRate;
  } catch (e) { out.offline_audio_err = e.message; }
  // chrome.runtime details (deeper inspection)
  out.chrome_runtime_id = !!(window.chrome?.runtime?.id);
  out.chrome_runtime_keys = window.chrome?.runtime ? Object.keys(window.chrome.runtime).sort().join(',') : '';
  out.chrome_app = !!window.chrome?.app;
  out.chrome_csi_native = (() => { try { return Function.prototype.toString.call(window.chrome?.csi).includes('[native code]'); } catch { return false; } })();

  // Canvas fingerprint hash (truncated)
  const c2 = document.createElement('canvas');
  c2.width = 200; c2.height = 50;
  const ctx = c2.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.font = '14px Arial';
  ctx.fillStyle = '#f60';
  ctx.fillRect(125, 1, 62, 20);
  ctx.fillStyle = '#069';
  ctx.fillText('Canvas FP <test> ✓', 2, 15);
  out.canvas_data_first_120 = c2.toDataURL().slice(22, 142);

  // chrome.* host object — must look like real Chrome
  out.has_window_chrome = !!window.chrome;
  out.chrome_runtime = !!window.chrome?.runtime;
  out.chrome_loadTimes_native = (() => {
    try { return Function.prototype.toString.call(window.chrome?.loadTimes).includes('[native code]'); } catch { return false; }
  })();

  // CDP detection: if anyone exposes window.cdc_, fail
  out.has_cdc = Object.keys(window).some(k => k.startsWith('cdc_'));

  // Function.prototype.toString of overridden functions — must end with [native code]
  out.webdriver_toString_native = Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')?.get).includes('[native code]');
  out.plugins_toString_native = Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins')?.get).includes('[native code]');

  // The smoking gun: if Reddit checks Notification.permission while
  // navigator.permissions.query says 'denied', that's a mismatch a real
  // browser never has. (Real Chrome: both return same value.)
  out.notification_permission = (typeof Notification !== 'undefined') ? Notification.permission : 'no_Notification_global';

  return out;
});

console.log(JSON.stringify(audit, null, 2));

// Also dump what the persona CLAIMS so we can diff
console.log('\n=== persona stored on session ===');
console.log(JSON.stringify(s.personaConfig, null, 2));

await s.close();
