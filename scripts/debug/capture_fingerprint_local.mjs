import { WSession } from '../../dist/session/wsession.js';
import { writeFileSync } from 'fs';

const FP_SCRIPT = `(async () => {
  var r = {};
  r.navigator = {
    userAgent: navigator.userAgent, appVersion: navigator.appVersion,
    platform: navigator.platform, vendor: navigator.vendor, product: navigator.product,
    productSub: navigator.productSub, webdriver: navigator.webdriver,
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
    languages: navigator.languages, language: navigator.language,
    maxTouchPoints: navigator.maxTouchPoints, doNotTrack: navigator.doNotTrack,
    cookieEnabled: navigator.cookieEnabled, pdfViewerEnabled: navigator.pdfViewerEnabled,
    plugins: Array.from(navigator.plugins||[]).map(p=>({name:p.name,filename:p.filename,description:p.description})),
    mimeTypes: Array.from(navigator.mimeTypes||[]).map(m=>({type:m.type,suffixes:m.suffixes})),
    connection: navigator.connection ? {effectiveType:navigator.connection.effectiveType,downlink:navigator.connection.downlink,rtt:navigator.connection.rtt} : null,
    appCodeName: navigator.appCodeName,
  };
  r.screen = {
    width: screen.width, height: screen.height,
    availWidth: screen.availWidth, availHeight: screen.availHeight,
    colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    orientation: screen.orientation?.type,
  };
  r.window = {
    devicePixelRatio: window.devicePixelRatio,
    outerWidth: window.outerWidth, outerHeight: window.outerHeight,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    screenX: window.screenX, screenY: window.screenY,
  };
  try {
    var c = document.createElement('canvas'); var gl = c.getContext('webgl');
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    r.webgl = {
      vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION),
      shadingVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      extensions: gl.getSupportedExtensions()?.length,
    };
  } catch(e) { r.webgl = {error: e.message}; }
  try {
    var c2 = document.createElement('canvas'); var gl2 = c2.getContext('webgl2');
    r.webgl2 = { supported: !!gl2, version: gl2?.getParameter(gl2.VERSION) };
  } catch { r.webgl2 = {supported: false}; }
  try {
    var cv = document.createElement('canvas'); cv.width=200; cv.height=50;
    var cx = cv.getContext('2d'); cx.textBaseline='top'; cx.font='14px Arial';
    cx.fillStyle='#f60'; cx.fillRect(125,1,62,20);
    cx.fillStyle='#069'; cx.fillText('Cwm fjord veg',2,15);
    r.canvasHash = cv.toDataURL().length;
  } catch { r.canvasHash = null; }
  try {
    var ac = new (window.AudioContext||window.webkitAudioContext)();
    r.audio = { sampleRate: ac.sampleRate, state: ac.state, maxChannels: ac.destination.maxChannelCount };
    ac.close();
  } catch { r.audio = null; }
  r.timezone = { offset: new Date().getTimezoneOffset(), name: Intl.DateTimeFormat().resolvedOptions().timeZone };
  r.chrome = { exists: typeof window.chrome !== 'undefined', runtime: !!window.chrome?.runtime, app: !!window.chrome?.app, csi: !!window.chrome?.csi, loadTimes: !!window.chrome?.loadTimes };
  try { var perm = await navigator.permissions.query({name:'notifications'}); r.permissions = {notifications: perm.state}; } catch { r.permissions = null; }
  try { var devs = await navigator.mediaDevices.enumerateDevices(); r.mediaDevices = devs.map(d=>({kind:d.kind,label:d.label?'yes':'no'})); } catch { r.mediaDevices = null; }
  r.speechVoices = window.speechSynthesis ? speechSynthesis.getVoices().length : 0;
  try { var bat = await navigator.getBattery(); r.battery = {charging:bat.charging,level:bat.level}; } catch { r.battery = null; }
  try { r.keyboard = { layoutMap: !!navigator.keyboard?.getLayoutMap }; } catch { r.keyboard = null; }
  return r;
})()`;

delete process.env.BRIGHTDATA_BROWSER_WS;
const s = await WSession.start({ label: 'fingerprint_local', proxy: 'none', record: false });
await s.goto('about:blank');
const fp = await s.page.evaluate(FP_SCRIPT);
const out = JSON.stringify(fp, null, 2);
console.log(out);
writeFileSync('recordings/local_fingerprint.json', out);
console.log('Saved to recordings/local_fingerprint.json');
await s.close();
