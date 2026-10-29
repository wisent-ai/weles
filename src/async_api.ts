/**
 * AsyncNewBrowser: launches the checksum-verified Weles Chromium or Firefox
 * release with a coherent fingerprint.
 *
 * The operating system and engine are the persona's, else the caller's
 * options; a launch that names neither is refused by name. The fingerprint
 * (browser/launch/context/surface.ts), the window (window.ts), the video
 * (recording.ts) and the browser-evidence flags (evidence-policy.ts) each
 * come from what was stated or measured.
 */

import { existsSync } from 'node:fs';
import type { BrowserContext, LaunchOptions } from 'playwright';
import {
  customBrowserSearchHint,
  findCustomBrowser,
} from './session/find_browser.js';
import type { Persona } from './browser/persona.js';
import {
  CHROMIUM_ARGS,
  type PreparedContextOptions,
} from './browser/launch/support.js';
import { launchChromiumContext } from './browser/launch/chromium.js';
import { launchFirefoxContext } from './browser/launch/firefox.js';
import { launchFingerprint } from './browser/launch/context/surface.js';
import {
  honestScreenEnabled,
  launchWindow,
} from './browser/launch/context/window.js';
import {
  honestHostEnabled,
  hostHardware,
  hostOsFamily,
} from './runtime/host_hardware.js';
import { recordVideoOption } from './browser/launch/context/recording.js';
import {
  BROWSER_EVIDENCE_POLICY,
  evidencePolicyArgs,
} from './browser/launch/context/evidence-policy.js';

export interface AsyncNewBrowserOptions {
  os?: string;
  browser?: string;
  proxy?: {
    server: string;
    username?: string;
    password?: string;
    country?: string;
    exit_ip?: string;
    platform?: string;
    /** The SPKI hashes of a TLS-intercepting provider's authority (ResolvedProxy.tls_spki). */
    tls_spki?: string[];
  };
  locale?: string;
  headless?: boolean;
  recordVideo?: boolean;
  excludeScripts?: string[];
  userDataDir?: string;
  persona?: Persona;
  pageDiagnostics?: boolean;
  userAgent?: string;
}

export async function AsyncNewBrowser(
  options: AsyncNewBrowserOptions = {},
): Promise<BrowserContext> {
  const persona = options.persona;
  const targetOs = persona?.os ?? options.os;
  if (!targetOs)
    throw new Error(
      'AsyncNewBrowser needs an operating system: give the launch a persona or name os (macos, windows or linux)',
    );
  const browserType = persona?.browser ?? options.browser;
  if (!browserType)
    throw new Error(
      'AsyncNewBrowser needs a browser engine: give the launch a persona or name browser (chromium or firefox)',
    );
  const isChromium = browserType === 'chromium';
  // A browser is headed unless the caller asks for a headless one.
  const headless = options.headless === true;
  const pageDiagnostics = options.pageDiagnostics !== false;
  // Network/HAR capture is CDP-level (Network domain, already enabled for routing)
  // and NOT visible to page JS — so it is decoupled from pageDiagnostics. A clean
  // anti-detect run keeps pageDiagnostics=false (no page-visible traps) yet still
  // records the HAR that challenge_outcome decoding needs. WELES_NO_RESPONSE_BODIES=1
  // opts out of the heavy body capture entirely.
  const captureHar = process.env.WELES_NO_RESPONSE_BODIES !== '1';
  const evidencePolicy =
    process.env.WELES_BROWSER_EVIDENCE_POLICY === BROWSER_EVIDENCE_POLICY;

  // The verified browser build is resolved first: the honest-host
  // measurement reads this host through the same build the run will use.
  const browserPath = findCustomBrowser(browserType);
  if (!browserPath)
    throw new Error(
      `WELES_${browserType.toUpperCase()}_BINARY_NOT_FOUND: ${customBrowserSearchHint(browserType)}`,
    );
  const host =
    honestHostEnabled() && hostOsFamily() === targetOs
      ? await hostHardware({
          browserType,
          executablePath: browserPath,
          withScreen: honestScreenEnabled(headless),
        })
      : undefined;
  const fpConfig = launchFingerprint({
    targetOs,
    browserType,
    persona,
    userAgent: options.userAgent,
    headless,
    host,
  });
  const window = launchWindow({ fpConfig, persona, headless, isChromium });

  // tz/locale NOT in ctxOpts (CDP Emulation -> TikTok mssdk detects). --lang + TZ env. Accept-Language IS set via extraHTTPHeaders (header only) so weles Firefox emits 'en-US,en;q=0.5', Chromium 'en-US,en;q=0.9' (computed in persona.ts).
  const ctxOpts: PreparedContextOptions = {
    userAgent: fpConfig.navigator.userAgent,
    viewport: { width: window.width, height: window.height },
    screen: { width: window.width, height: window.height },
    deviceScaleFactor: window.dpr,
    ...(persona?.acceptLanguage
      ? { extraHTTPHeaders: { 'accept-language': persona.acceptLanguage } }
      : {}),
  };
  if (evidencePolicy) {
    ctxOpts.acceptDownloads = false;
    ctxOpts.serviceWorkers = 'block';
  }
  if (options.proxy) ctxOpts.proxy = options.proxy;
  const recordVideo =
    options.recordVideo ?? process.env.WELES_DISABLE_RECORDING !== '1';
  if (recordVideo) ctxOpts.recordVideo = recordVideoOption();

  const launchOpts: LaunchOptions = { headless };
  // Language + timezone as binary-level signals (real Chrome behavior), not CDP emulation.
  if (persona?.timezone)
    launchOpts.env = { ...process.env, TZ: persona.timezone };

  const nopechaDir = process.env.WELES_NOPECHA_EXT_DIR;
  if (
    process.env.WELES_NOPECHA_EXT === '1' &&
    nopechaDir &&
    existsSync(nopechaDir) &&
    !headless
  ) {
    throw new Error(
      'NopeCha stock-browser launch is retired; Weles requires the verified Chromium release',
    );
  }

  if (!isChromium)
    return launchFirefoxContext({
      options,
      fpConfig,
      ctxOpts,
      launchOpts,
      pageDiagnostics,
      browserType,
    });

  const args = [...CHROMIUM_ARGS];
  if (process.env.WELES_CHROMIUM_PROFILE_DIRECTORY) {
    args.push(
      `--profile-directory=${process.env.WELES_CHROMIUM_PROFILE_DIRECTORY}`,
    );
  }
  if (evidencePolicy) args.push(...evidencePolicyArgs());
  if (persona?.language) args.push(`--lang=${persona.language}`);
  // A provider that intercepts TLS by design is trusted for exactly the
  // authority it declares; every other certificate is verified.
  const intercepting = options.proxy?.tls_spki;
  if (intercepting?.length) {
    args.push(
      `--ignore-certificate-errors-spki-list=${intercepting.join(',')}`,
    );
  }
  return launchChromiumContext({
    options,
    fpConfig,
    ctxOpts,
    launchOpts,
    pageDiagnostics,
    browserType,
    args,
    chromiumPath: browserPath,
    targetOs,
    captureHar,
  });
}

export class AsyncWeles {
  private _options: AsyncNewBrowserOptions;
  private _context: BrowserContext | null = null;

  constructor(options: AsyncNewBrowserOptions) {
    this._options = options;
  }

  async start(): Promise<BrowserContext> {
    this._context = await AsyncNewBrowser(this._options);
    return this._context;
  }

  async stop(): Promise<void> {
    if (this._context) {
      await this._context.close();
      this._context = null;
    }
  }
}
