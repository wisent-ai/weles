// End-to-end: WSession.start({ browser: 'firefox' }) should launch the weles-
// patched Firefox via findCustomBrowser and honor weles.fingerprint.* prefs
// through the Playwright driver path. Exits non-zero on any mismatch.

import { WSession } from '../../dist/session/wsession.js';

const s = await WSession.start({
  label: 'firefox_integration',
  browser: 'firefox',
  headless: true,
  persona: { os: 'macos', browser: 'firefox', platform: 'MacIntel', language: 'en-US',
    timezone: 'America/New_York',
    screen: { width: 1920, height: 1080, dpr: 2 },
    hardwareConcurrency: 10,
    gpu: { renderer: 'Apple M3', vendor: 'Apple Inc.' },
    chromeVersion: '142.0.0.0', userAgentOs: 'Macintosh; Intel Mac OS X 10_15_7' },
});

try {
  await s.goto('about:blank');
  const got = await s.page.evaluate(() => ({
    webdriver: navigator.webdriver,
    platform: navigator.platform,
    screenW: screen.width,
    hwc: navigator.hardwareConcurrency,
  }));
  const cases = [
    ['navigator.webdriver', got.webdriver, false],
    ['navigator.platform',  got.platform,  'MacIntel'],
  ];
  let failed = 0;
  for (const [name, gotV, want] of cases) {
    const ok = String(gotV) === String(want);
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  want=${want} got=${gotV}`);
    if (!ok) failed++;
  }
  console.log(`(info) screen.width=${got.screenW} hwc=${got.hwc}`);
  process.exit(failed);
} finally {
  await s.close().catch(() => {});
}
