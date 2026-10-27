import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
} from 'playwright';
import type { AsyncNewBrowserOptions } from '../../async_api.js';
import type { FingerprintConfig } from '../../fingerprint.js';
import type { HostHardware } from '../../runtime/host_hardware.js';

export interface RuntimeFingerprintConfig extends FingerprintConfig {
  _honestHost?: HostHardware;
  clientHints?: Record<string, unknown>;
}

export interface PreparedContextOptions extends BrowserContextOptions {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}

export interface ContextLaunchInput {
  options: AsyncNewBrowserOptions;
  fpConfig: RuntimeFingerprintConfig;
  ctxOpts: PreparedContextOptions;
  launchOpts: LaunchOptions;
  pageDiagnostics: boolean;
  browserType: string;
}

export function readDiagnosticScript(name: string): string {
  return readFileSync(
    join(__dirname, '..', '..', 'diagnostics', 'page', name),
    'utf-8',
  );
}
export const CHROMIUM_ARGS = [
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
/** The .app bundle a macOS executable lives in; absent for one outside a bundle. */
function macAppName(executablePath: string): string | undefined {
  return executablePath.match(/\/(?<app>[^/]+)\.app\//)?.groups?.app;
}

interface BinaryIdentity {
  sha256: string;
  mtime: string;
  bytes: number;
}

// G16: identity of the exact browser BUILD that ran. The binary hash is the
// expensive bit, so it is kept per path: the worker is long-lived and the
// binary does not change mid-process. A binary that cannot be read is an
// error, since the browser was just launched from it.
const binaryIdentities = new Map<string, BinaryIdentity>();
function binaryIdentity(path: string): BinaryIdentity {
  const known = binaryIdentities.get(path);
  if (known) return known;
  const stat = statSync(path);
  const identity = {
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mtime: stat.mtime.toISOString(),
    bytes: stat.size,
  };
  binaryIdentities.set(path, identity);
  return identity;
}

// The weles build label of an install path, e.g.
// ~/.local/share/weles-chromium/147.0.7727.108-weles.1/... -> 147.0.7727.108-weles.1;
// absent for a path outside a weles release directory.
function welesBuild(path: string): string | undefined {
  return path.match(/weles-(?:chromium|firefox)\/(?<build>[^/]+)\//)?.groups
    ?.build;
}

/** Which verified browser build ran, how it was started, and its content hash. */
export function browserProvenance(base: {
  browserType: string;
  source: string;
  executablePath: string;
  /**
   * The browser's process id: null when Playwright hands back no process (a
   * Firefox launch), undefined when the process it hands back reports none
   * (Node's ChildProcess.pid before or without a spawn).
   */
  pid: number | null | undefined;
  /** null for a persistent context, whose Playwright handle has no browser. */
  version: string | null;
  /** The arguments the browser was started with, as Playwright was given them. */
  launchArgs: LaunchOptions['args'];
}) {
  const { executablePath } = base;
  const binary = binaryIdentity(executablePath);
  return {
    browser_type: base.browserType,
    source: base.source,
    executable_path: executablePath,
    executable_basename: basename(executablePath),
    executable_dir: dirname(executablePath),
    mac_app_name: macAppName(executablePath),
    pid: base.pid,
    weles_build: welesBuild(executablePath),
    browser_version: base.version,
    binary_sha256: binary.sha256,
    binary_mtime: binary.mtime,
    binary_bytes: binary.bytes,
    launch_args: base.launchArgs,
  };
}

export function chromiumNetlogConfig(): {
  enabled: boolean;
  mode: string;
  includeCaptureMode: boolean;
} {
  // WELES_CHROMIUM_NETLOG is a switch ('1' on, '0' off) like the other WELES_*
  // flags; unset, full diagnostics decide. The capture detail is its own
  // setting: WELES_CHROMIUM_NETLOG_MODE=everything, otherwise the safe mode.
  const requested = process.env.WELES_CHROMIUM_NETLOG;
  const enabled =
    requested === '1' ||
    (requested !== '0' && process.env.WELES_FULL_DIAGNOSTICS === '1');
  const includeCaptureMode =
    process.env.WELES_CHROMIUM_NETLOG_MODE === 'everything';
  return {
    enabled,
    mode: includeCaptureMode ? 'everything' : 'safe',
    includeCaptureMode,
  };
}

// Top-level settings (locale, user agent, viewport) stay readable; every
// string nested in a sub-object (proxy, credentials, headers, storage state)
// is hidden, so no secret survives under a key nobody listed.
export function redactContextOpts(opts: unknown): unknown {
  return JSON.parse(
    JSON.stringify(opts, function (this: unknown, _key: string, v: unknown) {
      return typeof v === 'string' && this !== opts ? '<redacted>' : v;
    }),
  );
}

// Schemes a page loads itself, as the Fetch Standard names them: the HTTP(S)
// schemes and the local schemes (https://fetch.spec.whatwg.org/#local-scheme).
// Any other scheme a page reaches for is handed to a desktop application.
const FETCH_SCHEMES: Record<string, true> = {
  'http:': true,
  'https:': true,
  'about:': true,
  'blob:': true,
  'data:': true,
};

function customScheme(url: string): boolean {
  return (
    URL.canParse(url) && !Object.hasOwn(FETCH_SCHEMES, new URL(url).protocol)
  );
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
export function attachProtocolHandlerWatcher(context: BrowserContext) {
  const seen = new Set<string>();
  const shouldLog = (kind: string, url: string, origin: string): boolean => {
    if (process.env.WELES_LOG_CUSTOM_PROTOCOL === '1') return true;
    const key = `${kind}:${url}:${origin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  context.on('page', (page) => {
    page.on('framenavigated', (frame) => {
      const url = frame.url();
      if (customScheme(url) && shouldLog('nav', url, page.url()))
        console.log(`[async_api] custom-protocol nav attempted: ${url}`);
    });
    page.on('request', (req) => {
      const url = req.url();
      if (!customScheme(url)) return;
      const worker = req.serviceWorker();
      const origin = worker
        ? `service worker ${worker.url()}`
        : `frame ${req.frame().url()}`;
      if (shouldLog('request', url, origin))
        console.log(`[async_api] custom-protocol request: ${url} (${origin})`);
    });
  });
}
