import { FingerprintGenerator } from 'fingerprint-generator';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHROME_STABLE_VERSION = '147.0.6112.40';

const PLATFORM_MAP: Record<string, string> = {
  macos: 'MacIntel',
  windows: 'Win32',
  linux: 'Linux x86_64',
};

const MACOS_UA_TEMPLATE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/{version} Safari/537.36';

const WINDOWS_UA_TEMPLATE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/{version} Safari/537.36';

const LINUX_UA_TEMPLATE =
  'Mozilla/5.0 (X11; Linux x86_64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/{version} Safari/537.36';

const UA_TEMPLATES: Record<string, string> = {
  macos: MACOS_UA_TEMPLATE,
  windows: WINDOWS_UA_TEMPLATE,
  linux: LINUX_UA_TEMPLATE,
};

const WEBGL_RENDERERS: Record<string, string> = {
  macos: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
  windows: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  linux: 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)',
};

const WEBGL_UNMASKED_VENDORS: Record<string, string> = {
  macos: 'Google Inc. (Apple)',
  windows: 'Google Inc. (Intel)',
  linux: 'Intel Open Source Technology Center',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

  let ua: string = nav.userAgent ?? '';
  if (isChromium) {
    ua = ensureModernChromeUA(ua, targetOs);
  }

  const platform = PLATFORM_MAP[targetOs] ?? 'MacIntel';

  const navConfig: Record<string, any> = {
    userAgent: ua,
    platform,
    language: 'en-US',
    languages: ['en-US'],
    hardwareConcurrency: Math.min(nav.hardwareConcurrency ?? 8, 16),
    maxTouchPoints: nav.maxTouchPoints ?? 0,
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
  }

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
      availTop: scr.availTop ?? (targetOs === 'macos' ? 33 : 0),
      colorDepth: 24,
      pixelDepth: 24,
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
 * Convert a FingerprintConfig to the C++ config format for the custom Chromium
 * binary's --weles-fingerprint=<json> flag. Includes client hints with
 * "Google Chrome" brand for passing Google SSO.
 */
export function toCppConfig(config: FingerprintConfig, targetOs = 'macos'): Record<string, any> {
  const nav = config.navigator;
  const scr = config.screen;
  const webgl = config.webgl;
  let ua = nav.userAgent ?? '';
  const realVersion = detectChromiumVersion();
  // UA Reduction: real Chrome 101+ reports Chrome/<major>.0.0.0 in navigator.userAgent,
  // not the full four-part version. The full version is exposed only via client hints.
  // Not following UA Reduction flags us against every real Chrome baseline.
  const uaMajor = (realVersion ?? CHROME_STABLE_VERSION).split('.')[0];
  ua = ua.replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${uaMajor}.0.0.0`);
  // Strip anything after Safari/537.36 (removes LarkUrl, HeadlessChrome, etc)
  ua = ua.replace(/(Safari\/537\.36).*$/, '$1');
  const languages = [...(nav.languages ?? ['en-US'])];
  if (languages.length > 0) {
    const base = languages[0].split('-')[0];
    if (base && base !== languages[0] && !languages.includes(base)) languages.push(base);
  }
  const fullVersion = realVersion ?? CHROME_STABLE_VERSION;
  const major = fullVersion.split('.')[0];
  const platformMap: Record<string, [string, string]> = {
    macos: ['macOS', '10.15.7'], windows: ['Windows', '15.0.0'], linux: ['Linux', '6.5.0'],
  };
  const [chPlatform, chPlatformVersion] = platformMap[targetOs] ?? platformMap.macos;
  return {
    navigator: { userAgent: ua, platform: nav.platform, vendor: nav.vendor ?? 'Google Inc.', productSub: nav.productSub ?? '20030107', language: nav.language ?? 'en-US', languages, hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, doNotTrack: nav.doNotTrack ?? null },
    screen: { width: scr.width, height: scr.height, availWidth: scr.availWidth, availHeight: scr.availHeight, colorDepth: scr.colorDepth },
    webgl: { unmaskedVendor: webgl.unmaskedVendor, unmaskedRenderer: webgl.unmaskedRenderer },
    canvas: config.canvas, audio: config.audio,
    clientHints: { platform: chPlatform, platformVersion: chPlatformVersion, architecture: 'x86', bitness: '64', model: '', mobile: false, wow64: false, fullVersion,
      // Chrome's sec-ch-ua brand ORDER is produced by a deterministic
      // version-keyed greasing algorithm. The empirical order for v147 (verified
      // 2026-04-18 via side-by-side real Chrome capture) is
      //   [Google Chrome, Not.A/Brand, Chromium]
      // NOT alphabetical and NOT [Not.A/Brand, Chromium, Google Chrome] as this
      // file previously hard-coded, which TikTok's mssdk detected as non-Chrome.
      brandList: [{ brand: 'Google Chrome', version: major }, { brand: 'Not.A/Brand', version: '8' }, { brand: 'Chromium', version: major }],
      brandFullVersionList: [{ brand: 'Google Chrome', version: fullVersion }, { brand: 'Not.A/Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: fullVersion }],
    },
  };
}

function detectChromiumVersion(): string | null {
  const chromiumPath = process.env.CHROMIUM_PATH;
  if (!chromiumPath) return null;
  // Read version from Info.plist for macOS .app bundles (--version hangs)
  if (chromiumPath.includes('.app/')) {
    try {
      const { readFileSync } = require('node:fs');
      const plistDir = chromiumPath.replace(/\/Contents\/MacOS\/.*$/, '/Contents/Info.plist');
      const plist = readFileSync(plistDir, 'utf-8');
      const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+\.\d+\.\d+\.\d+)<\/string>/);
      return match ? match[1] : null;
    } catch { return null; }
  }
  // Linux/other: safe to call --version since the process exits normally
  try {
    const { execSync: exec } = require('node:child_process');
    const out = exec(`${JSON.stringify(chromiumPath)} --version 2>&1 || true`, { encoding: 'utf-8' });
    const match = (out as string).match(/(\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Replace an outdated Chrome version in the UA string with a modern one.
 * If Chrome/ major version is < 130, substitute a known-good template.
 */
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

function ensureModernChromeUA(ua: string, targetOs: string): string {
  const realVersion = detectChromiumVersion();
  const version = realVersion ?? CHROME_STABLE_VERSION;
  // Always use the real binary version in a clean template
  const template = UA_TEMPLATES[targetOs] ?? UA_TEMPLATES.macos;
  return template.replace('{version}', version);
}
