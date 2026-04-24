/**
 * Persona-based fingerprint rotation.
 *
 * A Persona is a coherent set of browser fingerprint values picked from
 * correlated pools. Each signup uses one Persona; its fields stay stable
 * across the session. The next signup picks a different Persona so
 * TikTok-style anti-abuse (which keys on device fingerprint) sees
 * different devices instead of "same device with rotating IPs".
 *
 * All pool entries are realistic combinations that exist in real traffic.
 * Independent randomization per field would produce obvious-bot fingerprints
 * (macOS UA + Intel UHD GPU + Windows colorDepth + Berlin timezone);
 * pools are gated by OS to keep combinations consistent.
 */

export interface Persona {
  os: 'macos' | 'windows' | 'linux';
  browser: 'chromium' | 'firefox' | 'webkit';
  chromeVersion: string;
  userAgentOs: string;
  platform: string;
  gpu: { vendor: string; renderer: string };
  screen: { width: number; height: number; dpr: number };
  hardwareConcurrency: number;
  audioSampleRate: 44100 | 48000;
  timezone: string;
  language: string;
  canvasSeed: number;
}

type Gpu = { vendor: string; renderer: string };

const MACOS_GPUS: Gpu[] = [
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)' },
  { vendor: 'Google Inc. (Intel Inc.)', renderer: 'ANGLE (Intel Inc., Intel(R) UHD Graphics 630, OpenGL 4.1)' },
];

const WINDOWS_GPUS: Gpu[] = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 (0x000067DF) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

const LINUX_GPUS: Gpu[] = [
  { vendor: 'Mesa', renderer: 'Mesa Intel(R) UHD Graphics 630 (CFL GT2)' },
  { vendor: 'Mesa', renderer: 'Mesa Intel(R) Xe Graphics (TGL GT2)' },
];

type ScreenSize = { width: number; height: number; dpr: number };

const MACOS_SCREENS: ScreenSize[] = [
  { width: 1440, height: 900, dpr: 2 },
  { width: 1680, height: 1050, dpr: 2 },
  { width: 2560, height: 1600, dpr: 2 },
  { width: 2048, height: 1280, dpr: 2 },
];

const WINDOWS_SCREENS: ScreenSize[] = [
  { width: 1366, height: 768, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1440, dpr: 1 },
  { width: 1536, height: 864, dpr: 1.25 },
];

const LINUX_SCREENS: ScreenSize[] = [
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1440, dpr: 1 },
];

const CHROME_VERSIONS = [
  '147.0.6112.40',
  '147.0.6112.85',
  '147.0.6112.122',
  '146.0.6044.199',
];

const COUNTRY_LOCALE: Record<string, { tz: string; lang: string }> = {
  US:    { tz: 'America/New_York', lang: 'en-US' },
  'US-W':{ tz: 'America/Los_Angeles', lang: 'en-US' },
  UK:    { tz: 'Europe/London', lang: 'en-GB' },
  GB:    { tz: 'Europe/London', lang: 'en-GB' },
  DE:    { tz: 'Europe/Berlin', lang: 'de-DE' },
  FR:    { tz: 'Europe/Paris', lang: 'fr-FR' },
  NL:    { tz: 'Europe/Amsterdam', lang: 'nl-NL' },
  CA:    { tz: 'America/Toronto', lang: 'en-CA' },
  AU:    { tz: 'Australia/Sydney', lang: 'en-AU' },
};

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

/**
 * Generate a coherent Persona.
 *
 * @param opts.country  ISO-2 country hint from the proxy (e.g. 'US', 'UK').
 *                      Controls timezone + language; defaults to US.
 * @param opts.os       Force a specific OS; by default sampled ~70% Windows,
 *                      25% macOS, 5% Linux to match real web traffic shape.
 */
export function generatePersona(opts: { country?: string; os?: Persona['os']; browser?: Persona['browser'] } = {}): Persona {
  const r = Math.random();
  const os: Persona['os'] = opts.os ?? (r < 0.70 ? 'windows' : r < 0.95 ? 'macos' : 'linux');
  // 60/40 chromium/firefox. Both browsers now carry engine-level weles patches:
  // chromium via chromium-build (canvas noise, UA reduction, ALPS, HEVC/audio
  // shims); firefox via firefox-build (navigator.webdriver, webgl vendor/renderer
  // de-sanitize, nsScreen + window-outer overrides, juggler integration).
  // Rotation = TLS/HTTP2 fingerprint rotation (BoringSSL vs NSS → different JA4).
  const br = Math.random();
  const browser: Persona['browser'] = opts.browser ?? (br < 0.60 ? 'chromium' : 'firefox');

  const gpu = os === 'macos' ? pick(MACOS_GPUS) : os === 'windows' ? pick(WINDOWS_GPUS) : pick(LINUX_GPUS);
  const screen = os === 'macos' ? pick(MACOS_SCREENS) : os === 'windows' ? pick(WINDOWS_SCREENS) : pick(LINUX_SCREENS);

  const userAgentOs = os === 'macos' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : os === 'windows' ? 'Windows NT 10.0; Win64; x64'
    : 'X11; Linux x86_64';
  const platform = os === 'macos' ? 'MacIntel' : os === 'windows' ? 'Win32' : 'Linux x86_64';

  const coreOptions = os === 'macos' ? [4, 8, 10, 12] : os === 'windows' ? [4, 6, 8, 12, 16] : [4, 8];
  const hardwareConcurrency = pick(coreOptions);
  const audioSampleRate: 44100 | 48000 = os === 'windows' ? 44100 : 48000;

  const country = (opts.country ?? 'US').toUpperCase();
  const locale = COUNTRY_LOCALE[country] ?? COUNTRY_LOCALE.US;

  const canvasSeed = Math.floor(Math.random() * 0xFFFFFFFF);
  const chromeVersion = pick(CHROME_VERSIONS);

  const rendererShort = gpu.renderer.match(/Apple M\d[^,)]*|UHD Graphics \d+|GTX \d+|RTX \d+|Radeon [A-Z]+ ?\d+|Iris[^,)]*/)?.[0] ?? 'GPU';
  console.log(`[persona] os=${os} browser=${browser} gpu=${rendererShort} screen=${screen.width}x${screen.height}@${screen.dpr} tz=${locale.tz} lang=${locale.lang}`);

  return {
    os, browser, chromeVersion, userAgentOs, platform, gpu, screen,
    hardwareConcurrency, audioSampleRate,
    timezone: locale.tz, language: locale.lang, canvasSeed,
  };
}
