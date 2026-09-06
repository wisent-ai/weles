/**
 * Async Playwright API — 1:1 port of weles/async_api.py
 *
 * Launches Playwright with custom Chromium binary + fingerprint spoofing.
 */

import { existsSync, writeFileSync, mkdtempSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type BrowserContext, type Browser } from 'playwright';
import { generate, toConfig, toCppConfig } from './fingerprint.js';
import { hostHardware, honestHostEnabled } from './host_hardware.js';
import { buildInitScript } from './page-init/loader.js';
import { pruneRecordings } from './prune.js';
import { launchWelesFirefox } from './browser/firefox_launch.js';
import { runRecordingsDir } from './session/run-recordings.js';
import { findCustomBrowser } from './session/find_browser.js';
import {
  WEBAUTHN_REJECT_SCRIPT,
  ARKOSE_OBSERVER_SCRIPT,
  ARKOSE_OBSERVER_SCRIPT_STOCK,
  FETCH_REGISTER_INTERCEPT_SCRIPT,
  MODERN_API_HOOKS_SCRIPT,
  SURFACE_INVENTORY_SCRIPT,
} from './browser/init_scripts.js';
import type { Persona } from './browser/persona.js';

const CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-infobars',
  // Pin window to known screen position so native input drivers (cliclick) can map CSS→screen without Accessibility perms.
  '--window-position=0,0',
  // claude.ai's "Continue with Google" uses GIS in popup mode and
  // posts the credential back to the opener via postMessage. The
  // default popup-blocker eats that popup, breaking OAuth (FAIL
  // diagnostic 05:31Z: callback not received within 180s after
  // GIS got to /gsi/transform with no opener tab). Allow it.
  '--disable-popup-blocking',
  // Suppress the Chromium-native "Open in <app>?" protocol-handler prompt.
  // It draws at the OS-window level (outside Playwright's screenshot
  // viewport and DOM), so any page that tries to open slack://, zoommtg://,
  // msteams://, vscode:// etc. while the desktop client is installed
  // produces an invisible-to-Playwright dialog that intercepts every
  // synthetic click. AutoLaunchProtocolsFromOrigins is the Chromium
  // feature that owns this prompt — disabling it makes the page silently
  // proceed without opening the app handler.
  '--disable-features=AutoLaunchProtocolsFromOrigins',
  // HTTP/2 + QUIC + TLS1.3 early-data + DNS-HTTPS + HTTPS Upgrades are default-on in Chrome 147. Disabling emits ALPN/TLS-ext/akamaiH2 deltas TikTok+Akamai flag. Switch providers, never globally disable.
  // WebRTC: without this, STUN can leak the real local/public IP even when a
  // proxy is configured. disable_non_proxied_udp forces WebRTC traffic through
  // the proxy/TURN and prevents UDP bypasses.
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  // Encrypted ClientHello can add an extra TLS extension after the first ECH-
  // capable site is visited, making JA4/peetprint drift within a single run.
  '--disable-features=EncryptedClientHello',
];

export interface AsyncNewBrowserOptions {
  os?: string;
  browser?: string;
  proxy?: { server: string; username?: string; password?: string; country?: string; exit_ip?: string; platform?: string };
  locale?: string;
  headless?: boolean;
  recordVideo?: boolean;
  excludeScripts?: string[];
  chromiumPath?: string;
  userDataDir?: string;
  persona?: Persona;
  pageDiagnostics?: boolean;
  userAgent?: string;
}

function inferMacAppName(executablePath: string): string | null {
  const m = executablePath.match(/\/([^/]+\.app)\//);
  return m?.[1]?.replace(/\.app$/, '') ?? null;
}

// G16: identity of the exact browser BUILD that ran. The binary hash is the
// expensive bit (shasum of a large Mach-O) so it is cached per path — the
// worker is long-lived and the binary does not change mid-process.
const _binaryIdentityCache = new Map<string, { sha256: string | null; mtime: string | null; bytes: number | null }>();
function binaryIdentity(path: string): { sha256: string | null; mtime: string | null; bytes: number | null } {
  const cached = _binaryIdentityCache.get(path);
  if (cached) return cached;
  const id: { sha256: string | null; mtime: string | null; bytes: number | null } = { sha256: null, mtime: null, bytes: null };
  try {
    const st = statSync(path);
    id.mtime = st.mtime.toISOString();
    id.bytes = st.size;
  } catch { /* best-effort */ }
  try {
    const out = execSync(`shasum -a 256 ${JSON.stringify(path)}`, { encoding: 'utf8', maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/)[0];
    if (/^[0-9a-f]{64}$/.test(out)) id.sha256 = out;
  } catch { /* best-effort */ }
  _binaryIdentityCache.set(path, id);
  return id;
}
// Parse the weles build label from an install path, e.g.
// ~/.local/share/weles-chromium/147.0.7727.108-weles.1/... -> 147.0.7727.108-weles.1
function parseWelesBuild(path: string): string | null {
  return path.match(/weles-(?:chromium|firefox)\/([^/]+)\//)?.[1] ?? null;
}

function browserProvenance(base: {
  browserType: string;
  source: string;
  executablePath?: string;
  channel?: string | null;
  pid?: number | null;
  customBinary?: boolean;
  stockOverride?: boolean;
  version?: string | null;
  launchArgs?: string[];
}): Record<string, any> {
  const executablePath = base.executablePath || null;
  const binId = executablePath ? binaryIdentity(executablePath) : { sha256: null, mtime: null, bytes: null };
  return {
    browser_type: base.browserType,
    source: base.source,
    executable_path: executablePath,
    executable_basename: executablePath ? basename(executablePath) : null,
    executable_dir: executablePath ? dirname(executablePath) : null,
    mac_app_name: executablePath ? inferMacAppName(executablePath) : null,
    channel: base.channel ?? null,
    pid: base.pid ?? null,
    custom_binary: base.customBinary ?? false,
    stock_override: base.stockOverride ?? false,
    playwright_default_chromium_path: null,
    // G16: exact build identity — which weles build, its real reported version,
    // a content hash + mtime/size of the binary, and the launch flags used.
    weles_build: executablePath ? parseWelesBuild(executablePath) : null,
    browser_version: base.version ?? null,
    binary_sha256: binId.sha256,
    binary_mtime: binId.mtime,
    binary_bytes: binId.bytes,
    launch_args: base.launchArgs ?? null,
  };
}

function chromiumNetlogConfig(): { enabled: boolean; mode: string; includeCaptureMode: boolean } {
  const requested = String(process.env.WELES_CHROMIUM_NETLOG ?? '').trim().toLowerCase();
  const fullDiagnostics = process.env.WELES_FULL_DIAGNOSTICS === '1';
  const disabled = requested === '0' || requested === 'false' || requested === 'off';
  const enabled = !disabled && (fullDiagnostics || requested === '1' || requested === 'safe' || requested === 'default' || requested === 'everything');
  const mode = (process.env.WELES_CHROMIUM_NETLOG_MODE ?? (requested === 'everything' ? 'everything' : 'safe')).trim().toLowerCase();
  return {
    enabled,
    mode,
    includeCaptureMode: mode === 'everything',
  };
}

function redactContextOpts(opts: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(opts, (k, v) => {
    if (/username|password|authorization|cookie|token|apikey|api_key|secret/i.test(k)) return '<redacted>';
    return v;
  }));
}

export async function AsyncNewBrowser(options: AsyncNewBrowserOptions = {}): Promise<BrowserContext> {
  const persona = options.persona;
  const targetOs = persona?.os ?? options.os ?? 'macos';
  const browserType = persona?.browser ?? options.browser ?? 'chromium';
  const isChromium = browserType === 'chromium';
  const headless = options.headless ?? false;
  const pageDiagnostics = options.pageDiagnostics !== false;
  // Network/HAR capture is CDP-level (Network domain, already enabled for routing)
  // and NOT visible to page JS — so it is decoupled from pageDiagnostics. A clean
  // anti-detect run keeps pageDiagnostics=false (no page-visible traps) yet still
  // records the HAR that challenge_outcome decoding needs. WELES_NO_RESPONSE_BODIES=1
  // opts out of the heavy body capture entirely.
  const captureHar = process.env.WELES_NO_RESPONSE_BODIES !== '1';

  const fp = generate({ os: targetOs, browser: browserType });
  const fpConfig = toConfig(fp, targetOs, browserType);
  // Allow callers to pin the HTTP + JS userAgent (e.g. to match a captcha
  // solver's UA so a returned clearance cookie stays valid).
  if (options.userAgent) {
    (fpConfig.navigator ?? (fpConfig.navigator = {})).userAgent = options.userAgent;
  }
  // Realized fingerprint actually presented to the page (UA, full UA-CH brand
  // list, navigator/screen/webgl). Captured onto the context so WSession can
  // persist it into session_meta -> account_action_logs.result (provenance).
  // Initialized to fpConfig (always present) and upgraded to the exact cppConfig
  // on the custom-Chromium path, so it is NEVER null — downstream persistence
  // is non-nullable by construction.
  let realizedFingerprint: Record<string, any> = fpConfig;

  // Persona overrides: apply coherent per-session fingerprint values.
  if (persona) {
    const n = fpConfig.navigator ?? {};
    n.platform = persona.platform;
    n.hardwareConcurrency = persona.hardwareConcurrency;
    if (persona.deviceMemory) n.deviceMemory = persona.deviceMemory;
    n.language = persona.language;
    // navigator.languages must be [primary, secondary] when primary has a region tag — real Firefox/Chrome always emit the bare-lang as the second entry (Mozilla intl.accept_languages, Chrome --lang both expand it). Bare single-entry array is engine-impossible and an obvious bot tell.
    n.languages = persona.language.includes('-') ? [persona.language, persona.language.split('-')[0]] : [persona.language];
    fpConfig.screen = { ...(fpConfig.screen ?? {}), width: persona.screen.width, height: persona.screen.height, availWidth: persona.screen.width, availHeight: persona.screen.height - 40, colorDepth: 24, pixelDepth: 24 };
    fpConfig.window = { ...(fpConfig.window ?? {}), devicePixelRatio: persona.screen.dpr, outerWidth: persona.screen.width + 2, outerHeight: persona.screen.height + 80, screenX: 10, screenY: 10 };
    fpConfig.webgl = { ...(fpConfig.webgl ?? {}), vendor: isChromium ? 'Google Inc.' : 'Mozilla', renderer: isChromium ? persona.gpu.renderer : persona.gpu.renderer.replace(/^ANGLE \([^,]+, ANGLE Metal Renderer: ([^,]+).*\)$/, '$1').replace(/^ANGLE \([^,]+, ([^,]+).*\)$/, '$1'), unmaskedVendor: isChromium ? persona.gpu.vendor : persona.gpu.vendor.replace(/^Google Inc\. \((.+)\)$/, '$1'), unmaskedRenderer: isChromium ? persona.gpu.renderer : persona.gpu.renderer.replace(/^ANGLE \([^,]+, ANGLE Metal Renderer: ([^,]+).*\)$/, '$1').replace(/^ANGLE \([^,]+, ([^,]+).*\)$/, '$1') };
    // Canvas noise NOT applied — LSB-flip makes canvas data URL 4x stock-Chrome size, TikTok mssdk flags.
  }

  // Phase 1 honest-host override (project-weles-anti-detect-goal): when the
  // target OS is the real host's OS, report the machine's ACTUAL physics
  // (GPU/cores/RAM/OS-version) rather than a synthetic or stale persona value.
  // The real silicon leaks through the WebGL pixel-hash + backend regardless of
  // what we claim, so a spoofed value is a detectable contradiction, not a
  // disguise. OS version is reported truthfully too (Phase 1 does not lie about
  // it). WELES_HONEST_HOST=0 opts out (e.g. cross-OS personas for TikTok).
  if (honestHostEnabled()) {
    const hw = hostHardware();
    if (hw.osFamily === targetOs) {
      const n = (fpConfig.navigator ?? (fpConfig.navigator = {})) as Record<string, any>;
      n.hardwareConcurrency = hw.cores;
      n.deviceMemory = hw.deviceMemory;
      if (hw.glRenderer) {
        fpConfig.webgl = {
          ...(fpConfig.webgl ?? {}),
          renderer: hw.glRenderer,
          unmaskedRenderer: hw.glRenderer,
          ...(hw.glUnmaskedVendor ? { unmaskedVendor: hw.glUnmaskedVendor } : {}),
        };
      }
      // Real display geometry: the synthetic persona's screen size + the forced
      // colorDepth:24 are macOS tells in headed production. Headless parity
      // audits need the opposite: real hardware, but viewport-sized screen.
      const honestScreenValue = String(process.env.WELES_HONEST_SCREEN ?? (headless ? '0' : '1')).trim().toLowerCase();
      const honestScreenEnabled = !['0', 'false', 'off', 'no'].includes(honestScreenValue);
      if (hw.screen && honestScreenEnabled) {
        const sc = hw.screen;
        fpConfig.screen = { ...(fpConfig.screen ?? {}),
          width: sc.width, height: sc.height, availWidth: sc.availWidth, availHeight: sc.availHeight,
          availLeft: 0, availTop: sc.availTop, colorDepth: sc.colorDepth, pixelDepth: sc.colorDepth };
        fpConfig.window = { ...(fpConfig.window ?? {}), devicePixelRatio: sc.dpr };
      } else if (hw.osFamily === 'macos' && fpConfig.screen && honestScreenEnabled) {
        // Fallback: at least correct colorDepth to Retina 30 (matches fingerprint.ts:170).
        fpConfig.screen = { ...fpConfig.screen, colorDepth: 30, pixelDepth: 30 };
      }
      // Carried to the cppConfig build below for the platformVersion override.
      (fpConfig as any)._honestHost = hw;
      console.log(`[async_api] honest-host: ${hw.chip ?? '?'} / ${hw.cores}c / ${hw.deviceMemory}GB / macOS ${hw.osVersion ?? '?'}`);
    }
  }

  const initScript = buildInitScript(fpConfig, options.excludeScripts);
  const nav = fpConfig.navigator ?? {};
  const honestScreenValueForViewport = String(process.env.WELES_HONEST_SCREEN ?? (headless ? '0' : '1')).trim().toLowerCase();
  const honestScreenForViewport = !['0', 'false', 'off', 'no'].includes(honestScreenValueForViewport);
  const _hhScreen = honestScreenForViewport ? (fpConfig as any)._honestHost?.screen : null;
  // Window (viewport) must not exceed the real panel — a persona screen taller/
  // wider than the honest screen (e.g. 2560x1600 persona on a 2560x1440 panel)
  // is a window-larger-than-screen tell. Cap to the real avail area.
  let viewW = persona?.screen.width ?? 1920;
  let viewH = persona?.screen.height ?? 1080;
  if (_hhScreen) { viewW = Math.min(viewW, _hhScreen.availWidth); viewH = Math.min(viewH, _hhScreen.availHeight); }
  const viewportOverride = process.env.WELES_VIEWPORT?.match(/^(\d{3,4})x(\d{3,4})$/);
  if (viewportOverride) {
    viewW = Math.min(parseInt(viewportOverride[1], 10), _hhScreen?.availWidth ?? 4096);
    viewH = Math.min(parseInt(viewportOverride[2], 10), _hhScreen?.availHeight ?? 2160);
  }
  // DPR must match the real panel (honest-host) so deviceScaleFactor renders at
  // the true scale — a window claiming DPR 1 while screen reports DPR 2 (or the
  // canvas/pixel-hash renders at the wrong scale) is a tell.
  const dpr = _hhScreen?.dpr ?? persona?.screen.dpr ?? 1;
  if (headless && isChromium) {
    fpConfig.screen = {
      ...(fpConfig.screen ?? {}),
      width: viewW,
      height: viewH,
      availWidth: viewW,
      availHeight: viewH,
      availLeft: 0,
      availTop: 0,
      colorDepth: 24,
      pixelDepth: 24,
    };
    fpConfig.window = {
      ...(fpConfig.window ?? {}),
      devicePixelRatio: dpr,
      outerWidth: viewW,
      outerHeight: viewH,
      innerWidth: viewW,
      innerHeight: viewH,
    };
  }

  // tz/locale NOT in ctxOpts (CDP Emulation -> TikTok mssdk detects). --lang + TZ env. Accept-Language IS set via extraHTTPHeaders (header only) so weles Firefox emits 'en-US,en;q=0.5', Chromium 'en-US,en;q=0.9' (computed in persona.ts).
  const ctxOpts: Record<string, any> = {
    userAgent: options.userAgent ?? nav.userAgent,
    viewport: { width: viewW, height: viewH },
    screen: { width: viewW, height: viewH },
    deviceScaleFactor: dpr,
    ...(persona?.acceptLanguage ? { extraHTTPHeaders: { 'accept-language': persona.acceptLanguage } } : {}),
  };
  if (process.env.WELES_BROWSER_EVIDENCE_POLICY === 'spis-browser-evidence.1') {
    ctxOpts.acceptDownloads = false;
    ctxOpts.serviceWorkers = 'block';
  }
  if (options.proxy) {
    ctxOpts.proxy = options.proxy;
    if (isChromium) ctxOpts.ignoreHTTPSErrors = true;
  }

  const recordVideo = options.recordVideo ?? (process.env.WELES_DISABLE_RECORDING !== '1');
  if (recordVideo) {
    const recDir = runRecordingsDir(); // G17: recordings/<run_uuid>/<action>/
    // Frame size 1280x720 by default — at 1920x1080 each Arkose canvas repaint sends ~2MB RGBA over Playwright→webm pipe and saturates the CDP channel.
    const [vw, vh] = (process.env.WELES_VIDEO_SIZE ?? '1280x720').split('x').map(n => parseInt(n, 10));
    ctxOpts.recordVideo = { dir: recDir, size: { width: vw || 1280, height: vh || 720 } };
    try {
      const budget = parseInt(process.env.WELES_RECORDINGS_MAX_BYTES ?? String(2 * 1024 * 1024 * 1024), 10);
      pruneRecordings(recDir, budget);
    } catch { /* skip */ }
  }

  // Launch only the checksum-verified, deployment-selected browser release.
  const selectedChromiumPath = isChromium ? findCustomBrowser('chromium') : undefined;
  if (isChromium && !selectedChromiumPath) {
    throw new Error('WELES_CHROMIUM_BINARY_NOT_FOUND: install the configured immutable Stado release');
  }
  const chromiumPath = selectedChromiumPath ?? '';
  const userDataDir = options.userDataDir ?? process.env.WELES_USER_DATA_DIR ?? '';
  const launchOpts: Record<string, any> = { headless };
  const args = [...CHROMIUM_ARGS];
  if (process.env.WELES_CHROMIUM_PROFILE_DIRECTORY) {
    args.push(`--profile-directory=${process.env.WELES_CHROMIUM_PROFILE_DIRECTORY}`);
  }
  if (process.env.WELES_BROWSER_EVIDENCE_POLICY === 'spis-browser-evidence.1') {
    const targetHost = String(process.env.WELES_BROWSER_EVIDENCE_TARGET_HOST ?? '');
    let targetAddresses: unknown;
    try { targetAddresses = JSON.parse(process.env.WELES_BROWSER_EVIDENCE_TARGET_ADDRESSES_JSON ?? 'null'); } catch {}
    if (!/^[A-Za-z0-9.-]+$/.test(targetHost)
        || !Array.isArray(targetAddresses)
        || targetAddresses.length === 0
        || typeof targetAddresses[0] !== 'string'
        || !/^[0-9A-Fa-f:.]+$/.test(targetAddresses[0])) {
      throw new Error('browser-evidence target resolver binding is invalid');
    }
    const pinnedAddress = targetAddresses[0].includes(':') ? `[${targetAddresses[0]}]` : targetAddresses[0];
    args.push(`--host-resolver-rules=MAP ${targetHost} ${pinnedAddress},MAP * ~NOTFOUND`);
    args.push(
      '--disable-background-networking',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-extensions',
      '--disable-notifications',
      '--disable-sync',
      '--no-pings',
      '--safebrowsing-disable-auto-update',
      '--block-new-web-contents',
      '--disable-external-intent-requests',
      '--disable-features=AutoLaunchProtocolsFromOrigins,EncryptedClientHello,PreconnectOnNavigation,Prerender2,SpeculationRulesPrefetch,ServiceWorkerStaticRouter,BackgroundFetch,PushMessaging,NotificationTriggers,DownloadBubble',
    );
  }

  // Language + timezone as binary-level signals (real Chrome behavior), not CDP emulation.
  if (persona?.language) args.push(`--lang=${persona.language}`);
  if (persona?.timezone) launchOpts.env = { ...process.env, TZ: persona.timezone };

  const nopechaDir = process.env.WELES_NOPECHA_EXT === '1' ? (process.env.WELES_NOPECHA_EXT_DIR ?? '') : '';
  const useNopecha = Boolean(nopechaDir && existsSync(nopechaDir) && headless === false);
  if (useNopecha) {
    throw new Error('NopeCha stock-browser launch is retired; Weles requires the verified Chromium release');
  }

  const isCustomBinary = isChromium;

  if (isCustomBinary) {
    launchOpts.executablePath = chromiumPath;
    const cppConfig = toCppConfig(fpConfig, targetOs, { chromiumPath });
    // Honest OS version: replace toCppConfig's default platformVersion with the
    // real host's (Phase 1 reports OS version truthfully). Explicit audit pins
    // still win so the Chrome-vs-Weles harness can compare equal surfaces.
    const _hh = (fpConfig as any)._honestHost;
    const pinnedPlatformVersion = process.env.WELES_CLIENT_HINTS_PLATFORM_VERSION || process.env.WELES_MAC_PLATFORM_VERSION;
    const pinnedArchitecture = process.env.WELES_CLIENT_HINTS_ARCHITECTURE;
    if (cppConfig.clientHints) {
      if (pinnedPlatformVersion) cppConfig.clientHints.platformVersion = pinnedPlatformVersion;
      else if (_hh?.platformVersion) cppConfig.clientHints.platformVersion = _hh.platformVersion;
      if (pinnedArchitecture) cppConfig.clientHints.architecture = pinnedArchitecture;
    }
    (fpConfig as any).clientHints = cppConfig.clientHints;
    if (cppConfig.clientHints) {
      (fpConfig.navigator as any).platformVersion = cppConfig.clientHints.platformVersion;
      (fpConfig.navigator as any).architecture = cppConfig.clientHints.architecture;
      (fpConfig.navigator as any).bitness = cppConfig.clientHints.bitness;
    }
    realizedFingerprint = cppConfig;
    const fpDir = mkdtempSync(join(tmpdir(), 'weles-fp-'));
    const fpFile = join(fpDir, 'config.json');
    writeFileSync(fpFile, JSON.stringify(cppConfig));
    args.push(`--weles-fingerprint=${fpFile}`);
    const netlog = chromiumNetlogConfig();
    let netLogPath = '';
    if (netlog.enabled) {
      const diagDir = runRecordingsDir(process.env.WELES_LABEL || 'unnamed'); // G17: recordings/<run_uuid>/<label>/
      mkdirSync(diagDir, { recursive: true });
      netLogPath = join(diagDir, 'netlog.json');
      args.push(`--log-net-log=${netLogPath}`);
      if (netlog.includeCaptureMode) args.push('--net-log-capture-mode=Everything');
    }
    if (process.env.WELES_CHROMIUM_NETLOG_VERBOSE === '1') { args.push('--enable-logging=stderr'); args.push('--v=1'); args.push('--vmodule=*/net/*=2,*/proxy*=2,*/http/*=2'); }
    // Opt-in HTTP/1.1 mode via WELES_DISABLE_HTTP2=1 — only when a residential proxy drops h2 frames inside CONNECT tunnels. Keeps h2 on by default for TikTok mssdk / Akamai h2 parity.
    if (process.env.WELES_DISABLE_HTTP2 === '1') {
      args.push('--disable-http2');
      args.push('--disable-quic');
    }
    launchOpts.args = args;
    // Re-enable breakpad so crash dumps appear in ~/Library/Logs/DiagnosticReports.
    launchOpts.ignoreDefaultArgs = ['--enable-automation', '--enable-unsafe-swiftshader', '--disable-breakpad'];
    if (process.env.WELES_USE_NATIVE_KEYCHAIN === '1') {
      launchOpts.ignoreDefaultArgs.push('--password-store=basic', '--use-mock-keychain');
    }
    console.log(`[async_api] Launching custom Chromium: ${chromiumPath}`);
    console.log(`[async_api] headless=${headless} proxy=${!!options.proxy} recordVideo=${recordVideo}`);
    console.log(`[async_api] fingerprint config: ${fpFile}`);
    if (netLogPath) console.log(`[async_api] netlog: ${netLogPath} mode=${netlog.mode}`);
    const persistentProfile = userDataDir.trim();
    if (persistentProfile) mkdirSync(persistentProfile, { recursive: true });
    const pwBrowser = persistentProfile ? null : await chromium.launch(launchOpts);
    const proc = (pwBrowser as any)?.process?.();
    const pid = proc?.pid;
    console.log(`[async_api] Browser launched, PID=${pid} hasProc=${!!proc} hasStdout=${!!proc?.stdout} hasStderr=${!!proc?.stderr}${persistentProfile ? ' persistentProfile=true' : ''}`);

    if (proc?.stderr) proc.stderr.on('data', (c: Buffer) => { const l = c.toString().trim(); if (l) console.log(`[chromium:stderr] ${l.slice(0, 1000)}`); });
    if (proc?.stdout) proc.stdout.on('data', (c: Buffer) => { const l = c.toString().trim(); if (l) console.log(`[chromium:stdout] ${l.slice(0, 1000)}`); });
    if (proc) {
      proc.on('exit', (code: number | null, signal: string | null) => console.log(`[chromium:exit] code=${code} signal=${signal} pid=${pid}`));
      proc.on('close', (code: number | null, signal: string | null) => console.log(`[chromium:close] code=${code} signal=${signal}${netLogPath ? ' netlog=' + netLogPath : ''}`));
      proc.on('error', (err: Error) => console.log(`[chromium:error] ${err.message}`));
    }
    pwBrowser?.on('disconnected', () => console.log(`[chromium:disconnected] pwBrowser disconnected pid=${pid}`));

    // Custom Chromium handles userAgent/screen via C++ — only pass viewport, proxy, recordVideo. tz via TZ env, lang via --lang.
    const customCtxOpts: Record<string, any> = { viewport: { width: viewW, height: viewH }, deviceScaleFactor: dpr };
    if (ctxOpts.proxy) { customCtxOpts.proxy = ctxOpts.proxy; customCtxOpts.ignoreHTTPSErrors = true; }
    if (ctxOpts.recordVideo) customCtxOpts.recordVideo = ctxOpts.recordVideo;
    if (ctxOpts.extraHTTPHeaders) customCtxOpts.extraHTTPHeaders = ctxOpts.extraHTTPHeaders;
    if (ctxOpts.acceptDownloads === false) customCtxOpts.acceptDownloads = false;
    if (ctxOpts.serviceWorkers === 'block') customCtxOpts.serviceWorkers = 'block';
    if (captureHar && process.env.WELES_LABEL) customCtxOpts.recordHar = { path: join(runRecordingsDir(process.env.WELES_LABEL), 'session.har'), content: 'embed', mode: 'full' }; // G17: recordings/<run_uuid>/<label>/session.har — sealed at context.close. Decoupled from pageDiagnostics: HAR is CDP-level, not page-visible.
    console.log(`[async_api] Context opts: ${JSON.stringify(redactContextOpts({ ...customCtxOpts, ...(persistentProfile ? { userDataDir: persistentProfile } : {}) }))}`);
    const context = persistentProfile
      ? await chromium.launchPersistentContext(persistentProfile, { ...launchOpts, ...customCtxOpts })
      : await pwBrowser!.newContext(customCtxOpts);
    // G1 fix: the custom-Chromium branch returns before the shared attach point
    // below, so attach the realized fingerprint here too — otherwise the
    // production path silently drops result.session.realized_fingerprint.
    (context as any)._welesFingerprintConfig = realizedFingerprint;
    (context as any)._welesBrowserProvenance = browserProvenance({
      browserType,
      source: persistentProfile ? 'custom-chromium-persistent' : 'custom-chromium',
      executablePath: chromiumPath,
      pid,
      customBinary: true,
      stockOverride: false,
      version: (() => { try { return (pwBrowser ?? context.browser())?.version() ?? null; } catch { return null; } })(),
      launchArgs: args,
    });
    if (persistentProfile) (context as any)._welesBrowserProvenance.user_data_dir = persistentProfile;
    context.setDefaultNavigationTimeout(0);
    console.log(`[async_api] Context created`);
    // Init-script injections. Chrome 147 stubs are fingerprint-parity shims;
    // page diagnostics are disabled for sensitive flows such as LinkedIn
    // register because wrappers/traps are visible to page JavaScript.
    const _inject = async (path: string, label: string) => { try { await context.addInitScript(readFileSync(path, 'utf-8')); console.log(`[async_api] ${label} installed`); } catch (e) { console.log(`[async_api] ${label} install failed: ${(e as Error).message}`); } };
    await _inject(join(__dirname, 'scripts', 'chrome147_stubs.js'), 'chrome147-stubs');
    // The custom Chromium binary handles most fingerprinting via --weles-fingerprint,
    // but a few properties (screen.availTop/availLeft, WebRTC IP leak) are not
    // overridden by the C++ path. Inject a small screen+WebRTC patch FIRST so it
    // survives even if the larger navigator.js stub fails on a challenging page.
    const screenPreamble = `const __weles = { screen: ${JSON.stringify(fpConfig.screen ?? {})} };`;
    const screenPatch = screenPreamble + '\n' + readFileSync(join(__dirname, 'scripts', 'screen_webrtc_patch.js'), 'utf-8');
    try { await context.addInitScript(screenPatch); console.log('[async_api] screen-webrtc-patch installed'); } catch (e) { console.log(`[async_api] screen-webrtc-patch install failed: ${(e as Error).message}`); }

    // Then inject the full navigator.js stub (plugins, mediaDevices, surface
    // APIs, etc.). Do NOT load automation.js here: it adds window properties
    // like __nightmare / _phantom that the fingerprint probe reads as automation
    // markers and flags as critical.
    const navPreamble = `const __weles = ${JSON.stringify(fpConfig)};` +
      `if (typeof _nativeOverrides === 'undefined') { var _nativeOverrides = new Set(); }` +
      `if (!window.__welesDefine) { window.__welesDefine = function(obj, prop, getter) { try { Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true }); } catch {} }; };` +
      `if (!window.__welesNativeString) { const _ns=new Set(); window.__welesNativeString=function(fn,name){_ns.add(fn);}; const _ots=Function.prototype.toString; Function.prototype.toString=function(){ if(_ns.has(this)) return 'function '+(this.name||'')+'() { [native code] }'; return _ots.call(this); }; }`;
    const navScript = navPreamble + '\n' + readFileSync(join(__dirname, 'scripts', 'navigator.js'), 'utf-8');
    try { await context.addInitScript(navScript); console.log('[async_api] navigator-stubs installed'); } catch (e) { console.log(`[async_api] navigator-stubs install failed: ${(e as Error).message}`); }
    if (pageDiagnostics) {
      await _inject(join(__dirname, 'diagnostics', 'property_trap.js'), 'property-trap');
      await _inject(join(__dirname, 'diagnostics', 'input_recorder.js'), 'input-recorder');
      await context.addInitScript(WEBAUTHN_REJECT_SCRIPT);
      await context.addInitScript(ARKOSE_OBSERVER_SCRIPT);
      await context.addInitScript(FETCH_REGISTER_INTERCEPT_SCRIPT);
      await context.addInitScript(MODERN_API_HOOKS_SCRIPT);
      await context.addInitScript(SURFACE_INVENTORY_SCRIPT);
    }
    attachProtocolHandlerWatcher(context);
    const origClose = context.close.bind(context);
    (context as any).close = async () => {
      // Graceful close, but time-boxed: a crashed/unresponsive Chromium makes
      // origClose/pwBrowser.close hang, and since pwBrowser.process() is null
      // for the custom binary we have no PID to fall back on.
      const withTimeout = (p: Promise<unknown>, ms: number) =>
        Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => setTimeout(r, ms))]);
      await withTimeout(origClose(), 8000);
      await withTimeout(pwBrowser?.close() ?? Promise.resolve(), 5000);
      // Backstop reap: kill THIS run's Chromium tree by its unique
      // --weles-fingerprint=<fpDir> arg. Concurrency-safe — the fpDir basename
      // is unique per launch, so this never touches a sibling run's browser.
      // No-op if the graceful close already terminated it.
      try {
        const { execFile } = await import('node:child_process');
        const tag = fpDir.split('/').pop(); // e.g. weles-fp-Pf0jrD — unique per run
        if (tag) await new Promise<void>(res => execFile('pkill', ['-f', tag], () => res()));
      } catch { /* pkill unavailable / nothing to kill */ }
      try { const { rmSync } = await import('node:fs'); rmSync(fpDir, { recursive: true, force: true }); } catch { /* already gone */ }
    };
    return context;
  }

  // The only non-Chromium branch is the verified Weles Firefox release.
  const firefoxPath = findCustomBrowser('firefox');
  if (!firefoxPath) {
    throw new Error('WELES_FIREFOX_BINARY_NOT_FOUND: install the configured immutable Stado release');
  }
  const pwBrowser = await launchWelesFirefox({ launchOpts, persona, nav, fpConfig, proxy: options.proxy });
  const context = await pwBrowser.newContext(ctxOpts);
  // Playwright's public type omits Weles-owned context metadata fields.
  const annotatedContext = context as unknown as BrowserContext & {
    _welesFingerprintConfig: unknown;
    _welesBrowserProvenance: unknown;
  };
  annotatedContext._welesFingerprintConfig = realizedFingerprint;
  annotatedContext._welesBrowserProvenance = browserProvenance({
    browserType,
    source: 'weles-firefox-release',
    executablePath: firefoxPath,
    pid: null,
    customBinary: true,
    stockOverride: false,
    version: (() => { try { return pwBrowser.version(); } catch { return null; } })(),
  });
  context.setDefaultNavigationTimeout(0);

  // Strip Accept-Language on TikTok same-origin sub-requests (Chrome 147 default-on ReduceAcceptLanguage omits it; weles emits unconditionally; webmssdk signs into x-mssdk-info). EXCEPTION: passport/web/* CORS preflight needs it.
  await context.route('**/*', async (route: any) => {
    const req = route.request();
    const url = req.url();
    if (/passport\/web\//.test(url)) { await route.continue(); return; }
    if (/tiktok\.com|tiktokv\.us|tiktokcdn|byteoversea|mssdk\./.test(url) && req.isNavigationRequest() === false) {
      const headers = { ...req.headers() };
      delete headers['accept-language'];
      await route.continue({ headers });
      return;
    }
    await route.continue();
  });

  await context.addInitScript(initScript);
  if (pageDiagnostics) {
    await context.addInitScript(WEBAUTHN_REJECT_SCRIPT);
    await context.addInitScript(ARKOSE_OBSERVER_SCRIPT_STOCK);
    await context.addInitScript(FETCH_REGISTER_INTERCEPT_SCRIPT);
    // Diagnostic shims — engine-agnostic (pure DOM/JS), were Chromium-custom-binary-only before this; now on stock path too so Firefox sessions also dump navigator-access traces.
    for (const f of ['property_trap.js', 'input_recorder.js']) { try { await context.addInitScript(readFileSync(join(__dirname, 'diagnostics', f), 'utf-8')); console.log(`[async_api] ${f.split('.')[0]} installed`); } catch (e) { console.log(`[async_api] ${f} install failed: ${(e as Error).message}`); } }
    try { let _fh=readFileSync(join(__dirname, 'diagnostics', 'fingerprint_hooks.js'), 'utf-8'); if (persona && !isChromium) { const _g:any=(fpConfig as any).webgl??{}; _fh=_fh.replace(/__WELES_GL_VENDOR__/g, _g.unmaskedVendor||_g.vendor||'Mozilla').replace(/__WELES_GL_RENDERER__/g, _g.unmaskedRenderer||_g.renderer||''); } await context.addInitScript(_fh); console.log('[async_api] fingerprint_hooks installed'); } catch (e) { console.log(`[async_api] fingerprint_hooks install failed: ${(e as Error).message}`); }
  }
  attachProtocolHandlerWatcher(context);

  const origClose = context.close.bind(context);
  (context as any).close = async () => { await origClose(); await pwBrowser?.close(); };

  return context;
}

/**
 * Observe navigation attempts to custom URI schemes (slack://, zoommtg://,
 * msteams://, vscode://, etc.) so trajectories are not blind to the
 * Chromium-native "Open in <app>?" prompt that would otherwise draw at
 * the OS-window level (invisible to page.screenshot() and DOM queries).
 *
 * Pair with the --disable-features=AutoLaunchProtocolsFromOrigins launch
 * flag above. The flag prevents the prompt from blocking the page; this
 * watcher logs the attempt so the trajectory knows the page tried to
 * launch a desktop client.
 */
function attachProtocolHandlerWatcher(context: BrowserContext) {
  const seen = new Set<string>();
  const shouldLog = (kind: string, url: string, frameUrl = ''): boolean => {
    if (process.env.WELES_LOG_CUSTOM_PROTOCOL === '1') return true;
    const key = `${kind}:${url}:${frameUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  context.on('page', (page) => {
    page.on('framenavigated', (frame) => {
      const url = frame.url();
      const scheme = url.split(':', 1)[0];
      if (scheme && scheme !== 'http' && scheme !== 'https'
          && scheme !== 'about' && scheme !== 'data' && scheme !== 'blob') {
        if (shouldLog('nav', url)) console.log(`[async_api] custom-protocol nav attempted: ${url.slice(0, 200)}`);
      }
    });
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('http') || url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:')) return;
      const frameUrl = req.frame()?.url?.() ?? '';
      if (shouldLog('request', url, frameUrl)) console.log(`[async_api] custom-protocol request: ${url.slice(0, 200)} (frame=${frameUrl.slice(0, 80)})`);
    });
  });
}

export class AsyncWeles {
  private _options: AsyncNewBrowserOptions;
  private _context: BrowserContext | null = null;

  constructor(options: AsyncNewBrowserOptions = {}) {
    this._options = options;
  }

  async start(): Promise<BrowserContext> {
    this._context = await AsyncNewBrowser(this._options);
    return this._context;
  }

  async stop(): Promise<void> {
    if (this._context) { await this._context.close(); this._context = null; }
  }
}
