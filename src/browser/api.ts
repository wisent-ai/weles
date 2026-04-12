import { type ChildProcess } from 'node:child_process';
import { CDPConnection } from '../cdp/connection.js';
import { launchChromium } from '../cdp/launcher.js';
import { generate, toConfig, toCppConfig, type FingerprintConfig } from '../fingerprint.js';
import { buildInitScript } from '../scripts/loader.js';
import { CDPBrowserContext } from './context.js';

export interface WelesLaunchOptions {
  os?: string;
  config?: Partial<FingerprintConfig>;
  proxy?: string;
  locale?: string;
  headless?: boolean;
  userDataDir?: string;
  excludeScripts?: string[];
  chromiumPath?: string;
  recordVideo?: boolean;
}

function getSystemLocale(): string {
  // Try LANG env var first (e.g. "en_US.UTF-8" -> "en-US")
  const lang = process.env.LANG;
  if (lang) {
    const base = lang.split('.')[0]; // strip encoding
    return base.replace('_', '-');
  }
  // Fall back to Intl
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en-US';
  }
}

export class CDPWeles {
  private _process: ChildProcess;
  private _connection: CDPConnection;
  private _context: CDPBrowserContext;

  private constructor(
    proc: ChildProcess,
    connection: CDPConnection,
    context: CDPBrowserContext,
  ) {
    this._process = proc;
    this._connection = connection;
    this._context = context;
  }

  static async launch(options: WelesLaunchOptions = {}): Promise<CDPWeles> {
    const locale = options.locale ?? getSystemLocale();
    const targetOs = options.os ?? 'macos';

    // 1. Generate fingerprint
    const fp = generate({ os: targetOs, browser: 'chromium' });

    // 2. Convert to config
    const config = toConfig(fp, targetOs, 'chromium');

    // 3. Build init script (skip for custom binary — C++ handles spoofing)
    const isCustomBinary = !!(options.chromiumPath || process.env.CHROMIUM_PATH);
    const initScript = isCustomBinary ? '' : buildInitScript(config, options.excludeScripts);

    // 4. Launch chromium — pass --weles-fingerprint for custom binary
    const extraArgs: string[] = [];
    if (isCustomBinary) {
      const cppConfig = toCppConfig(config, targetOs);
      extraArgs.push(`--weles-fingerprint=${JSON.stringify(cppConfig)}`);
    }
    const { process: proc, wsUrl } = await launchChromium({
      headless: options.headless,
      chromiumPath: options.chromiumPath,
      userDataDir: options.userDataDir,
      proxyServer: options.proxy,
      args: extraArgs,
    });

    // 5. Connect via CDP
    const connection = new CDPConnection();
    await connection.connect(wsUrl);

    // 6. Create browser context
    const { browserContextId } = await connection.send('Target.createBrowserContext', {});

    // 7. Create CDPBrowserContext
    const context = new CDPBrowserContext(connection, browserContextId, {
      recordVideo: options.recordVideo,
    });

    // 8. Set emulation — skip UA/platform for custom binary (C++ handles it)
    context.setEmulation({
      userAgent: isCustomBinary ? '' : config.navigator.userAgent,
      viewportWidth: config.window.outerWidth ?? 1920,
      viewportHeight: (config.window.outerHeight ?? 1080) - 80,
      deviceScaleFactor: config.window.devicePixelRatio,
      acceptLanguage: locale,
      platform: isCustomBinary ? '' : config.navigator.platform,
    });

    // 9. Add init script
    if (initScript) context.addInitScript(initScript);

    // 10. WebAuthn passkey stub (prevents passkey prompts on Google SSO)
    context.addInitScript(`try{var _og=navigator.credentials.get.bind(navigator.credentials);navigator.credentials.get=function(o){return o&&o.publicKey?new Promise(function(){}):_og(o)}}catch(e){}`);

    return new CDPWeles(proc, connection, context);
  }

  get context(): CDPBrowserContext {
    return this._context;
  }

  async close(): Promise<void> {
    try {
      await this._context.close();
    } catch {
      // context may already be disposed
    }

    try {
      await this._connection.close();
    } catch {
      // connection may already be closed
    }

    try {
      this._process.kill();
    } catch {
      // process may already be terminated
    }
  }
}

/**
 * Launch a browser and return the context directly.
 * Convenience wrapper around CDPWeles.launch().
 */
export async function cdpNewBrowser(
  options: WelesLaunchOptions = {},
): Promise<CDPBrowserContext> {
  const weles = await CDPWeles.launch(options);
  return weles.context;
}
