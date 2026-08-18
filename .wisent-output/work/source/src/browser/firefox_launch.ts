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
import { customBrowserSearchHint, findCustomBrowser } from '../session/find_browser.js';

interface FirefoxLaunchInput {
  launchOpts: Record<string, any>;
  persona?: { language?: string } | null;
  nav: Record<string, any>;
  fpConfig: FingerprintConfig;
  proxy?: { server: string; username?: string; password?: string };
}

export async function launchWelesFirefox(input: FirefoxLaunchInput): Promise<Browser> {
  const { launchOpts, persona, nav, fpConfig, proxy } = input;
  // intl.accept_languages must include the bare-lang secondary (e.g. 'en-US, en'); Firefox emits navigator.languages and the Accept-Language q-list from this pref, and a bare 'en-US' produces engine-impossible single-entry navigator.languages (2026-05-29 collector diff vs Chromium).
  const _accLang = persona?.language ? (persona.language.includes('-') ? `${persona.language}, ${persona.language.split('-')[0]}` : persona.language) : 'en-US, en';
  // webgl.{renderer,vendor}-string-override force Gecko's GL implementation to return our values for both 0x1f00/0x1f01 (sanitized) and 0x9245/0x9246 (UNMASKED_*_WEBGL). Without these, RFP-style placeholders ("Apple M1, or similar") leak even with resistFingerprinting:false. Read the already-Firefox-stripped values from fpConfig.webgl (async_api bdc03ff strips ANGLE/Google-Inc. wrappers).
  const _glR = (fpConfig.webgl as any)?.unmaskedRenderer || (fpConfig.webgl as any)?.renderer;
  const _glV = (fpConfig.webgl as any)?.unmaskedVendor || (fpConfig.webgl as any)?.vendor;
  launchOpts.firefoxUserPrefs = Object.assign({
    'privacy.resistFingerprinting': false,
    'privacy.fingerprintingProtection': false,
    'dom.webdriver.enabled': false,
    'intl.accept_languages': _accLang,
  }, nav.userAgent && { 'general.useragent.override': nav.userAgent },
     nav.platform && { 'general.platform.override': nav.platform },
     nav.oscpu && { 'general.oscpu.override': nav.oscpu },
     nav.appVersion && { 'general.appversion.override': nav.appVersion },
     nav.hardwareConcurrency && { 'dom.maxHardwareConcurrency': nav.hardwareConcurrency },
     _glR && { 'webgl.renderer-string-override': _glR },
     _glV && { 'webgl.vendor-string-override': _glV },
     toFirefoxWelesPrefs(fpConfig));
  // Firefox-specific proxy fix: must be set at launch level too.
  if (proxy) launchOpts.proxy = proxy;
  const ffBin = findCustomBrowser('firefox');
  if (!ffBin) {
    throw new Error(`WELES_FIREFOX_BINARY_NOT_FOUND: ${customBrowserSearchHint('firefox')}`);
  }
  launchOpts.executablePath = ffBin;
  return firefox.launch(launchOpts);
}
