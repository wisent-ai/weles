// The Chromium side of a fingerprint: the stable version the user agent
// claims, the templates and renderer tables it is drawn from, the version
// read off the real binary, and the config the patched Chromium takes on
// its --weles-fingerprint flag. `../fingerprint.ts` owns generation and the
// browser-neutral config.

import type { FingerprintConfig, FingerprintVersionOptions } from '../fingerprint.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHROME_STABLE_VERSION = '147.0.6112.40';

export const PLATFORM_MAP: Record<string, string> = {
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

export const WEBGL_RENDERERS: Record<string, string> = {
  macos: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
  windows: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  linux: 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)',
};

export const WEBGL_UNMASKED_VENDORS: Record<string, string> = {
  macos: 'Google Inc. (Apple)',
  windows: 'Google Inc. (Intel)',
  linux: 'Intel Open Source Technology Center',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Convert a FingerprintConfig to the C++ config format for the custom Chromium
 * binary's --weles-fingerprint=<json> flag. Includes client hints with
 * "Google Chrome" brand for passing Google SSO.
 */
export function toCppConfig(
  config: FingerprintConfig,
  targetOs = 'macos',
  versionOptions?: FingerprintVersionOptions,
): Record<string, any> {
  const nav = config.navigator;
  const scr = config.screen;
  const webgl = config.webgl;
  let ua = nav.userAgent ?? '';
  const realVersion = resolveChromiumVersion(versionOptions);
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
  // Sec-CH-UA high-entropy platform + arch. The UA string itself stays frozen at
  // "Intel Mac OS X 10_15_7" (Chrome reduced-UA), but the high-entropy
  // platformVersion must report the REAL macOS version — leaking 10.15.7 here was
  // a stub tell. Architecture must match the GPU: macOS personas present an Apple
  // M1 renderer (WEBGL_RENDERERS.macos = Apple Silicon), which reports arch 'arm',
  // NOT 'x86'. A macOS fingerprint claiming an M1 GPU with x86 arch is physically
  // impossible and trips detection (observed: LinkedIn checkpoint right after
  // createAccount). Windows/Linux remain x86.
  const platformMap: Record<string, [string, string, string]> = {
    macos: ['macOS', '15.5.0', 'arm'], windows: ['Windows', '15.0.0', 'x86'], linux: ['Linux', '6.5.0', 'x86'],
  };
  const [chPlatform, defaultPlatformVersion, defaultArchitecture] = platformMap[targetOs] ?? platformMap.macos;
  const chPlatformVersion =
    process.env.WELES_CLIENT_HINTS_PLATFORM_VERSION
    || process.env.WELES_MAC_PLATFORM_VERSION
    || defaultPlatformVersion;
  const chArchitecture =
    process.env.WELES_CLIENT_HINTS_ARCHITECTURE
    || defaultArchitecture;
  return {
    navigator: { userAgent: ua, platform: nav.platform, vendor: nav.vendor ?? 'Google Inc.', productSub: nav.productSub ?? '20030107', language: nav.language ?? 'en-US', languages, hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory, doNotTrack: nav.doNotTrack ?? null },
    screen: (() => {
      const top = scr.availTop ?? (targetOs === 'macos' ? 30 : 0);
      const left = scr.availLeft ?? 0;
      return {
        width: scr.width,
        height: scr.height,
        availTop: top,
        availLeft: left,
        availWidth: scr.availWidth ?? (scr.width - left),
        availHeight: scr.availHeight ?? (scr.height - top),
        colorDepth: scr.colorDepth,
        pixelDepth: scr.pixelDepth ?? scr.colorDepth,
      };
    })(),
    webgl: { unmaskedVendor: webgl.unmaskedVendor, unmaskedRenderer: webgl.unmaskedRenderer },
    canvas: config.canvas, audio: config.audio,
    clientHints: { platform: chPlatform, platformVersion: chPlatformVersion, architecture: chArchitecture, bitness: '64', model: '', mobile: false, wow64: false, fullVersion,
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

function resolveChromiumVersion(options?: FingerprintVersionOptions): string | null {
  if (options?.chromiumVersion && /^\d+\.\d+\.\d+\.\d+$/.test(options.chromiumVersion)) {
    return options.chromiumVersion;
  }
  return detectChromiumVersion(options?.chromiumPath);
}

function detectChromiumVersion(chromiumPath = process.env.CHROMIUM_PATH): string | null {
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

export function ensureModernChromeUA(ua: string, targetOs: string): string {
  const realVersion = detectChromiumVersion();
  const version = realVersion ?? CHROME_STABLE_VERSION;
  // Always use the real binary version in a clean template
  const template = UA_TEMPLATES[targetOs] ?? UA_TEMPLATES.macos;
  return template.replace('{version}', version);
}
