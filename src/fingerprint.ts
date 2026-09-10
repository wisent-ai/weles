import { FingerprintGenerator } from 'fingerprint-generator';
import { firefoxNav } from './browser/persona.js';

import { PLATFORM_MAP, WEBGL_RENDERERS, WEBGL_UNMASKED_VENDORS, ensureModernChromeUA } from './fingerprint/chromium.js';

export { toCppConfig } from './fingerprint/chromium.js';


export interface GenerateOptions {
  os?: string;
  browser?: string;
}

/**
 * Generate a browser fingerprint using `fingerprint-generator`.
 *
 * @param options.os      - Target OS: "macos", "windows", or "linux".
 * @param options.browser - Browser family (default "chrome").
 */
export function generate(options?: GenerateOptions): any {
  const browser = options?.browser ?? 'chrome';
  const os = options?.os;

  const generatorOpts: Record<string, any> = {
    browsers: [browser === 'chromium' ? 'chrome' : browser],
    browserListQuery: 'last 5 chrome versions',
  };

  if (os) {
    const osMap: Record<string, string> = {
      macos: 'macos',
      windows: 'windows',
      linux: 'linux',
    };
    generatorOpts.operatingSystems = [osMap[os] ?? os];
  }

  const gen = new FingerprintGenerator(generatorOpts);
  return gen.getFingerprint();
}

export interface FingerprintConfig {
  browser: string;
  navigator: Record<string, any>;
  screen: Record<string, any>;
  window: Record<string, any>;
  webgl: Record<string, any>;
  canvas: Record<string, any>;
  audio: Record<string, any>;
}

export interface FingerprintVersionOptions {
  chromiumPath?: string;
  chromiumVersion?: string;
}

/**
 * Convert a generated fingerprint object to a JS-ready config dict
 * suitable for injection via the init scripts.
 *
 * @param fingerprint - Raw fingerprint from `generate()`.
 * @param targetOs    - Target OS string (default "macos").
 * @param browser     - "chromium" (default) or "firefox".
 */
export function toConfig(
  fingerprint: any,
  targetOs = 'macos',
  browser = 'chromium',
): FingerprintConfig {
  const fp = fingerprint.fingerprint ?? fingerprint;
  const nav = fp.navigator ?? {};
  const scr = fp.screen ?? {};

  const isChromium = browser === 'chromium';

  // Firefox: generate()'s chrome-pinned browserlist returns a Chrome UA even
  // for browser:'firefox'; the patched Gecko binary then mismatches it. Build
  // a coherent Firefox navigator instead. Chromium: UA Reduction so the
  // navigator.js-injected UA matches real Chrome on cross-origin iframes.
  const ffNav = isChromium ? null : firefoxNav(targetOs);
  let ua: string = ffNav ? ffNav.userAgent
    : ensureModernChromeUA(nav.userAgent ?? '', targetOs).replace(/Chrome\/(\d+)\.\d+\.\d+\.\d+/, 'Chrome/$1.0.0.0');

  const platform = PLATFORM_MAP[targetOs] ?? 'MacIntel';

  // maxTouchPoints: fingerprint-generator sometimes emits >0 for desktop OSes
  // (observed 10 for Windows personas), which is unrealistic for non-touch
  // desktops and flags reCAPTCHA. Force 0 for Windows/Linux desktop; leave
  // macOS at the generator value (could be 0 for MacBooks or tied to trackpad).
  const rawMtp = nav.maxTouchPoints ?? 0;
  const isDesktopOs = targetOs === 'windows' || targetOs === 'linux';
  const maxTouchPoints = isDesktopOs ? 0 : rawMtp;

  const navConfig: Record<string, any> = {
    userAgent: ua,
    platform,
    language: 'en-US',
    languages: ['en-US'],
    hardwareConcurrency: Math.min(nav.hardwareConcurrency ?? 8, 16),
    maxTouchPoints,
    doNotTrack: null,
  };

  if (isChromium) {
    navConfig.appVersion = ua.startsWith('Mozilla/')
      ? ua.replace('Mozilla/', '')
      : ua;
    navConfig.vendor = 'Google Inc.';
    navConfig.product = 'Gecko';
    navConfig.productSub = '20030107';
    navConfig.pdfViewerEnabled = true;
  } else { Object.assign(navConfig, ffNav); }

  const webglVendor = isChromium ? 'Google Inc.' : 'Mozilla';

  return {
    browser,
    navigator: navConfig,
    screen: {
      width: scr.width ?? 1920,
      height: scr.height ?? 1080,
      availWidth: scr.availWidth ?? scr.width ?? 1920,
      availHeight: scr.availHeight ?? (scr.height ? scr.height - 40 : 1040),
      // availLeft/availTop are the desktop's offset for taskbar/menubar.
      // Real Chrome on macOS exposes availTop=33 (menu bar) + availLeft=0;
      // Windows is 0/0; Linux varies but usually 0/0. Their absence on weles
      // is a fingerprint tell PerimeterX/Akamai check via 'availTop' in screen.
      availLeft: scr.availLeft ?? 0,
      availTop: scr.availTop ?? (targetOs === 'macos' ? 30 : 0),
      // macOS Retina/HDR displays report colorDepth=30 (10-bit per channel).
      // Diff'd 2026-04-25 vs real Chrome on M2 Mac: chrome=30, weles=24 (this
      // file's hardcoded value). PerimeterX li.protechts.net iframe reads it.
      // Windows/Linux still 24 — common LCD output.
      colorDepth: targetOs === 'macos' ? 30 : 24,
      pixelDepth: targetOs === 'macos' ? 30 : 24,
    },
    window: {
      devicePixelRatio: scr.devicePixelRatio ?? 1,
      outerWidth: (scr.width ?? 1920) + 2,
      outerHeight: (scr.height ?? 1080) + 80,
      screenX: 10,
      screenY: 10,
    },
    webgl: {
      vendor: webglVendor,
      renderer: WEBGL_RENDERERS[targetOs] ?? WEBGL_RENDERERS.macos,
      unmaskedVendor: WEBGL_UNMASKED_VENDORS[targetOs] ?? WEBGL_UNMASKED_VENDORS.macos,
      unmaskedRenderer: WEBGL_RENDERERS[targetOs] ?? WEBGL_RENDERERS.macos,
    },
    // Canvas noise intentionally disabled: the LSB-flip noise (image_data_buffer.cc
    // NoiseCanvasPixmap) was a 4x-sized, high-entropy data URL vs real Chrome 147
    // on the same Mac. TikTok's mssdk compares canvas hashes to a Chrome baseline;
    // our noised output never matches, which is itself the fingerprint. Off → the
    // canvas renders identically to stock Chrome for this machine.
    canvas: {},
    audio: {},
  };
}

/**
 * Map a FingerprintConfig to the weles.fingerprint.* prefs the patched
 * Firefox reads (firefox-build/patches/0001 registers them). Stock Firefox
 * ignores unknown prefs; patched Firefox short-circuits the native
 * navigator/screen/window/webgl getters. Empty strings / zeros disable the
 * override so partial configs are safe.
 */
export function toFirefoxWelesPrefs(config: FingerprintConfig): Record<string, any> {
  const scr = config.screen ?? {};
  const win = config.window ?? {};
  const gl = config.webgl ?? {};
  return {
    'weles.fingerprint.webdriver.force': true,
    'weles.fingerprint.webgl.vendor': gl.unmaskedVendor ?? gl.vendor ?? '',
    'weles.fingerprint.webgl.renderer': gl.unmaskedRenderer ?? gl.renderer ?? '',
    'weles.fingerprint.screen.width': scr.width ?? 0,
    'weles.fingerprint.screen.height': scr.height ?? 0,
    'weles.fingerprint.screen.avail_width': scr.availWidth ?? 0,
    'weles.fingerprint.screen.avail_height': scr.availHeight ?? 0,
    'weles.fingerprint.window.outer_width': win.outerWidth ?? 0,
    'weles.fingerprint.window.outer_height': win.outerHeight ?? 0,
    'weles.fingerprint.window.screen_x': win.screenX ?? 0,
    'weles.fingerprint.window.screen_y': win.screenY ?? 0,
  };
}

