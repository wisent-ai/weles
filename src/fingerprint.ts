import { FingerprintGenerator } from 'fingerprint-generator';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHROME_STABLE_VERSION = '135.0.7049.95';

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
  macos: 'Apple M1, or similar',
  windows: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
  linux: 'Mesa Intel(R) UHD Graphics 630',
};

const WEBGL_UNMASKED_VENDORS: Record<string, string> = {
  macos: 'Apple',
  windows: 'Google Inc. (Intel)',
  linux: 'Intel',
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
  const deviceMemory = [4, 8, 8, 16][Math.floor(Math.random() * 4)];

  const navConfig: Record<string, any> = {
    userAgent: ua,
    platform,
    language: 'en-US',
    languages: ['en-US'],
    hardwareConcurrency: nav.hardwareConcurrency ?? 8,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    doNotTrack: 'unspecified',
  };

  if (isChromium) {
    navConfig.appVersion = ua.startsWith('Mozilla/')
      ? ua.replace('Mozilla/', '')
      : ua;
    navConfig.vendor = 'Google Inc.';
    navConfig.product = 'Gecko';
    navConfig.productSub = '20030107';
    navConfig.deviceMemory = deviceMemory;
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
      availHeight: scr.availHeight ?? (scr.height ? scr.height - 25 : 1055),
      colorDepth: scr.colorDepth ?? 24,
      pixelDepth: scr.pixelDepth ?? 24,
    },
    window: {
      devicePixelRatio: scr.devicePixelRatio ?? 1,
      outerWidth: scr.width ?? 1920,
      outerHeight: scr.height ?? 1080,
    },
    webgl: {
      vendor: webglVendor,
      renderer: WEBGL_RENDERERS[targetOs] ?? WEBGL_RENDERERS.macos,
      unmaskedVendor: WEBGL_UNMASKED_VENDORS[targetOs] ?? WEBGL_UNMASKED_VENDORS.macos,
      unmaskedRenderer: WEBGL_RENDERERS[targetOs] ?? WEBGL_RENDERERS.macos,
    },
    canvas: { noiseSeed: Math.floor(Math.random() * 2 ** 31) + 1 },
    audio: { noiseSeed: Math.floor(Math.random() * 2 ** 31) + 1 },
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
  if (ua && realVersion) ua = ua.replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${realVersion}`);
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
    navigator: { userAgent: ua, platform: nav.platform, vendor: nav.vendor ?? 'Google Inc.', productSub: nav.productSub ?? '20030107', language: nav.language ?? 'en-US', languages, hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, doNotTrack: nav.doNotTrack ?? 'unspecified' },
    screen: { width: scr.width, height: scr.height, availWidth: scr.availWidth, availHeight: scr.availHeight, colorDepth: scr.colorDepth },
    webgl: { unmaskedVendor: webgl.unmaskedVendor, unmaskedRenderer: webgl.unmaskedRenderer },
    canvas: config.canvas, audio: config.audio,
    clientHints: { platform: chPlatform, platformVersion: chPlatformVersion, architecture: 'x86', bitness: '64', model: '', mobile: false, wow64: false, fullVersion,
      brandList: [{ brand: 'Not.A/Brand', version: '8' }, { brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }],
      brandFullVersionList: [{ brand: 'Not.A/Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: fullVersion }, { brand: 'Google Chrome', version: fullVersion }],
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
function ensureModernChromeUA(ua: string, targetOs: string): string {
  const realVersion = detectChromiumVersion();
  const version = realVersion ?? CHROME_STABLE_VERSION;
  const match = ua.match(/Chrome\/(\d+)/);
  if (match) {
    const major = parseInt(match[1], 10);
    if (major >= 130) {
      return realVersion ? ua.replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${realVersion}`) : ua;
    }
  }
  const template = UA_TEMPLATES[targetOs] ?? UA_TEMPLATES.macos;
  return template.replace('{version}', version);
}
