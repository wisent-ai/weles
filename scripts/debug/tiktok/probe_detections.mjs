// Enumerate which BotD detection properties our weles Chromium has.
// TikTok uses these exact checks; we want to know which ones fire.

import { WSession } from '../../../dist/session/wsession.js';
import { generatePersona } from '../../../dist/browser/persona.js';

const DETECT_JS = `(() => {
  const r = {};
  r.pwInitScripts = !!window.__pwInitScripts;
  r.pwBinding = !!window.__playwright__binding__;
  r.webdriver = navigator.webdriver;
  r.chromeRuntime = !!(window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage);
  r.languages = navigator.languages;
  r.languagesLen = navigator.languages?.length || 0;
  r.bodyDisplay = document.body ? window.getComputedStyle(document.body).display : '(no body yet)';

  const leaks = [];
  for (const k in window) {
    if (/cdc_[a-z0-9]/gi.test(k)) leaks.push('cdc:' + k);
    else if (k.includes('Devtools') && k !== 'webpackChunkmodernjsDevtools') leaks.push('devtools:' + k);
    else if (k.startsWith('_cdp')) leaks.push('cdp:' + k);
  }
  r.leakProps = leaks;

  r.nightmare = typeof window.nightmare !== 'undefined';
  r.__nightmare = typeof window.__nightmare !== 'undefined';
  r.callPhantom = typeof window.callPhantom !== 'undefined';
  r._phantom = typeof window._phantom !== 'undefined';
  r.__phantomas = typeof window.__phantomas !== 'undefined';
  r._Selenium_IDE_Recorder = typeof window._Selenium_IDE_Recorder !== 'undefined';
  r._selenium = typeof window._selenium !== 'undefined';
  r.__selenium_evaluate = typeof document.__selenium_evaluate !== 'undefined';
  r.__webdriver_evaluate = typeof document.__webdriver_evaluate !== 'undefined';
  r.awesomium = typeof window.awesomium !== 'undefined';
  r.RunPerfTest = typeof window.RunPerfTest !== 'undefined';
  r.CefSharp = typeof window.CefSharp !== 'undefined';
  r.fmget_targets = typeof window.fmget_targets !== 'undefined';
  r.geb = typeof window.geb !== 'undefined';
  r.wdioElectron = typeof window.wdioElectron !== 'undefined';

  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    r.webgl = ext ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : '(no ext)';
  } catch (e) { r.webgl = 'err:' + e.message; }

  try { null.foo; } catch (e) { r.errorTrace = e.stack?.slice(0, 200) || '-'; }
  r.evalLength = eval.toString().length;
  try { r.hasProcess = typeof process !== 'undefined'; r.electronVer = (typeof process !== 'undefined') ? process?.versions?.electron : undefined; } catch { r.hasProcess = false; }

  const bannedKeys = '__proto__ __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__'.split(' ');
  const weirdKeys = Object.keys(window).filter(k =>
    k.startsWith('__') || k.startsWith('$') || /^[a-z]+_[a-z]+_(Array|Promise|Symbol)$/.test(k)
  ).filter(k => !bannedKeys.includes(k));
  r.weirdWindowKeys = weirdKeys;

  // BotD uses Object.getOwnPropertyNames(window); replicate that exactly.
  const ownNames = Object.getOwnPropertyNames(window);
  const docOwnNames = Object.getOwnPropertyNames(document);
  r.ownPropsCount = ownNames.length;
  const patternsPacked = 'awesomium:awesomium|cef:RunPerfTest|cefsharp:CefSharp|coachjs:emit|fminer:fmget_targets|geb:geb|nightmarejs:__nightmare,nightmare|phantomas:__phantomas|phantomjs:callPhantom,_phantom|rhino:spawn|selenium_w:_Selenium_IDE_Recorder,_selenium,calledSelenium|webdriverio:wdioElectron|webdriver_w:webdriver,__webdriverFunc,_WEBDRIVER_ELEM_CACHE,ChromeDriverw|headless_chrome:domAutomation,domAutomationController';
  const hits = {};
  for (const entry of patternsPacked.split('|')) {
    const [k, propList] = entry.split(':');
    const matches = propList.split(',').filter(p => ownNames.includes(p));
    if (matches.length) hits[k] = matches;
  }
  r.distinctivePropsHits = hits;
  r.firstHitKey = Object.keys(hits)[0] || null;
  const seleniumRegexMatches = ownNames.filter(n => /^([a-z]){3}_.*_(Array|Promise|Symbol)$/.test(n));
  r.seleniumRegexMatches = seleniumRegexMatches;

  // HEVC / proprietary-codec shim verification. The tiktok webapp-login-page
  // bundle probes these three APIs with this exact content type and caches
  // the result in localStorage.hevc_support_key_v4. Real Chrome 147 on macOS
  // returns true/probably/true because of platform VideoToolbox support;
  // vanilla weles (open-source Chromium) returns false/empty/false. The
  // chrome147_stubs.js init script should override all three to claim
  // HEVC support.
  try {
    const codec = 'video/mp4;codecs="hev1.1.6.L93.B0"';
    r.hevc_MediaSource = MediaSource.isTypeSupported(codec);
    r.hevc_canPlayType = document.createElement('video').canPlayType(codec);
  } catch (e) { r.hevc_err = e.message; }
  r.Sanitizer_type = typeof window.Sanitizer;
  r.AnimationTrigger_type = typeof window.AnimationTrigger;

  return r;
})()`;

// Side channel: also await mediaCapabilities.decodingInfo since it returns
// a promise. Run outside the sync DETECT_JS block.
const HEVC_ASYNC_JS = `navigator.mediaCapabilities.decodingInfo({
  type: 'file',
  video: { contentType: 'video/mp4;codecs="hev1.1.6.L93.B0"', width: 1920, height: 1080, bitrate: 10000, framerate: 30 }
}).then(d => ({ supported: d.supported, smooth: d.smooth, powerEfficient: d.powerEfficient }))
  .catch(e => ({ err: e.message }))`;

const persona = generatePersona({ country: 'US', os: 'windows' });
const s = await WSession.start({ label: 'probe_detections', proxy: process.env.PROBE_PROXY || 'residential', persona });

// Add an init script to see if Playwright's init script mechanism leaks __pwInitScripts
if (process.env.USE_INIT_SCRIPT === '1') {
  await s.ctx.addInitScript({ content: '(() => { window.__probe_marker = true; })();' });
}

try {
  await s.page.goto('https://example.com');
  await s.wait(2);
  const baseline = await s.page.evaluate(DETECT_JS);
  baseline.hevc_mediaCapabilities = await s.page.evaluate(HEVC_ASYNC_JS);
  console.log('=== DETECTIONS (baseline, example.com) ===');
  console.log(JSON.stringify(baseline, null, 2));

  await s.page.goto('https://www.tiktok.com/signup/phone-or-email/email');
  await s.wait(6);
  const onTikTok = await s.page.evaluate(DETECT_JS);
  console.log('\n=== DETECTIONS (on TikTok signup page) ===');
  console.log(JSON.stringify(onTikTok, null, 2));
} catch (e) {
  console.error('ERR:', e.message?.slice(0, 300));
} finally {
  await s.close().catch(() => {});
}
