// Firefox launch path extracted from async_api.ts.
//
// Two responsibilities the original async_api.ts inline block didn't handle:
//   1. Assemble firefoxUserPrefs (pref-level fingerprint enforcement on stock
//      Firefox + weles-patched binary).
//   2. Pin proxy at launch level. Playwright's per-context `proxy` on Firefox
//      is a no-op for DNS resolution — the engine resolves hostnames locally
//      before consulting the proxy and emits NS_ERROR_UNKNOWN_HOST in
//      environments without direct DNS to the target. Setting both launch
//      AND context proxy is the documented fix.

import { firefox, type Browser } from 'playwright';
import { toFirefoxWelesPrefs, type FingerprintConfig } from '../fingerprint.js';
import { findCustomBrowser } from '../session/find_browser.js';

interface FirefoxLaunchInput {
  launchOpts: Record<string, any>;
  persona?: { language?: string } | null;
  nav: Record<string, any>;
  fpConfig: FingerprintConfig;
  proxy?: { server: string; username?: string; password?: string };
}

export async function launchWelesFirefox(input: FirefoxLaunchInput): Promise<Browser> {
  const { launchOpts, persona, nav, fpConfig, proxy } = input;
  launchOpts.firefoxUserPrefs = Object.assign({
    'privacy.resistFingerprinting': false,
    'privacy.fingerprintingProtection': false,
    'dom.webdriver.enabled': false,
  }, persona?.language && { 'intl.accept_languages': persona.language },
     nav.userAgent && { 'general.useragent.override': nav.userAgent },
     nav.platform && { 'general.platform.override': nav.platform },
     nav.oscpu && { 'general.oscpu.override': nav.oscpu },
     nav.appVersion && { 'general.appversion.override': nav.appVersion },
     nav.hardwareConcurrency && { 'dom.maxHardwareConcurrency': nav.hardwareConcurrency },
     toFirefoxWelesPrefs(fpConfig));
  // Firefox-specific proxy fix: must be set at launch level too.
  if (proxy) launchOpts.proxy = proxy;
  const ffBin = findCustomBrowser('firefox');
  if (ffBin) launchOpts.executablePath = ffBin;
  return firefox.launch(launchOpts);
}
