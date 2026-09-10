import { readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import type { BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright';
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
  return readFileSync(join(__dirname, '..', '..', 'diagnostics', 'page', name), 'utf-8');
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

export function browserProvenance(base: {
  browserType: string;
  source: string;
  executablePath?: string;
  channel?: string | null;
  pid?: number | null;
  customBinary?: boolean;
  stockOverride?: boolean;
  version?: string | null;
  launchArgs?: string[];
}) {
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

export function chromiumNetlogConfig(): { enabled: boolean; mode: string; includeCaptureMode: boolean } {
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

export function redactContextOpts(opts: unknown): unknown {
  return JSON.parse(JSON.stringify(opts, (k, v) => {
    if (/username|password|authorization|cookie|token|apikey|api_key|secret/i.test(k)) return '<redacted>';
    return v;
  }));
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
