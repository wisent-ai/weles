// Firefox-prefs audit. Launch Playwright's Firefox with a candidate batch of
// fingerprint-relevant firefoxUserPrefs and dump what the rendered page
// actually reports for each surface. Answers the question: which Chromium
// C++ patches in chromium-build can be replaced on Firefox by a pref, vs
// which truly need a Gecko fork for Phase 2?

import { firefox } from 'playwright';

const TARGET_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:137.0) Gecko/20100101 Firefox/137.0';

const candidatePrefs = {
  // We already set these in async_api.ts; repeat here for the audit.
  'privacy.resistFingerprinting': false,
  'privacy.fingerprintingProtection': false,
  'dom.webdriver.enabled': false,
  'intl.accept_languages': 'en-US',
  'general.useragent.override': TARGET_UA,
  // Candidates under audit.
  'webgl.renderer-string-override': 'Apple M3',
  'webgl.vendor-string-override': 'Apple Inc.',
  'dom.maxHardwareConcurrency': 10,
  'intl.locale.requested': 'en-US',
  'general.platform.override': 'MacIntel',
  'general.oscpu.override': 'Intel Mac OS X 10.15',
  'general.appversion.override': '5.0 (Macintosh)',
};

const b = await firefox.launch({ headless: true, firefoxUserPrefs: candidatePrefs });
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.goto('about:blank');

const got = await page.evaluate(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 16;
  const ctx = canvas.getContext('webgl');
  let vendor = '', renderer = '';
  try {
    const ext = ctx.getExtension('WEBGL_debug_renderer_info');
    vendor = ctx.getParameter(ext.UNMASKED_VENDOR_WEBGL);
    renderer = ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch (_) {}
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    oscpu: navigator.oscpu || '(undefined)',
    appVersion: navigator.appVersion,
    hardwareConcurrency: navigator.hardwareConcurrency,
    language: navigator.language,
    languages: navigator.languages,
    screenW: screen.width,
    screenH: screen.height,
    availW: screen.availWidth,
    availH: screen.availHeight,
    webdriver: navigator.webdriver,
    webglVendor: vendor,
    webglRenderer: renderer,
  };
});

const rows = [
  ['userAgent',           'general.useragent.override',    TARGET_UA,            got.userAgent],
  ['platform',            'general.platform.override',     'MacIntel',           got.platform],
  ['oscpu',               'general.oscpu.override',        'Intel Mac OS X 10.15', got.oscpu],
  ['appVersion',          'general.appversion.override',   '5.0 (Macintosh)',    got.appVersion],
  ['hardwareConcurrency', 'dom.maxHardwareConcurrency',    10,                   got.hardwareConcurrency],
  ['language',            'intl.locale.requested',         'en-US',              got.language],
  ['webgl vendor',        'webgl.vendor-string-override',  'Apple Inc.',         got.webglVendor],
  ['webgl renderer',      'webgl.renderer-string-override','Apple M3',           got.webglRenderer],
  ['screen.width',        '(no pref)',                     '(?)',                got.screenW],
  ['screen.height',       '(no pref)',                     '(?)',                got.screenH],
  ['webdriver',           'dom.webdriver.enabled=false',   '(undefined)',        String(got.webdriver)],
];

console.log('surface'.padEnd(22) + 'pref'.padEnd(38) + 'want'.padEnd(28) + 'got');
console.log('-'.repeat(110));
for (const [surface, pref, want, gotVal] of rows) {
  const ok = String(want) === String(gotVal) ? 'OK  ' : 'MISS';
  console.log(`${ok} ${surface.padEnd(20)}${String(pref).padEnd(38)}${String(want).slice(0,26).padEnd(28)}${String(gotVal).slice(0,40)}`);
}

await b.close();
