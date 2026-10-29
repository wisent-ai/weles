import type { BrowserContext } from 'playwright';
import { buildInitScript } from '../../page-init/loader.js';
import {
  customBrowserSearchHint,
  findCustomBrowser,
} from '../../session/find_browser.js';
import { launchWelesFirefox } from './firefox_launch.js';
import {
  browserProvenance,
  attachProtocolHandlerWatcher,
  readDiagnosticScript,
} from './support.js';
import type {
  ContextLaunchInput,
  RuntimeFingerprintConfig,
} from './support.js';
import {
  WEBAUTHN_REJECT_SCRIPT,
  ARKOSE_OBSERVER_SCRIPT_STOCK,
  FETCH_REGISTER_INTERCEPT_SCRIPT,
} from './init_scripts.js';

/**
 * The fingerprint hooks shim with the GPU strings this launch presents.
 * Gecko sanitizes the standard GL_VENDOR/GL_RENDERER parameters into strings
 * that leak the host GPU, so the shim answers them with the fingerprint's
 * unmasked vendor and renderer; a fingerprint without them is refused.
 */
function fingerprintHooks(fpConfig: RuntimeFingerprintConfig): string {
  const { unmaskedVendor, unmaskedRenderer } = fpConfig.webgl;
  if (
    typeof unmaskedVendor !== 'string' ||
    typeof unmaskedRenderer !== 'string'
  )
    throw new Error(
      `WELES_FIREFOX_GL_UNSTATED: the fingerprint states no unmasked WebGL vendor or renderer (vendor ${JSON.stringify(unmaskedVendor)}, renderer ${JSON.stringify(unmaskedRenderer)}), so fingerprint_hooks.js has no GPU to report`,
    );
  return readDiagnosticScript('fingerprint_hooks.js')
    .replace(/__WELES_GL_VENDOR__/g, unmaskedVendor)
    .replace(/__WELES_GL_RENDERER__/g, unmaskedRenderer);
}

export async function launchFirefoxContext(
  input: ContextLaunchInput,
): Promise<BrowserContext> {
  const {
    options,
    fpConfig,
    ctxOpts,
    launchOpts,
    pageDiagnostics,
    browserType,
  } = input;
  const persona = options.persona;
  const nav = fpConfig.navigator;
  const realizedFingerprint = fpConfig;
  const initScript = buildInitScript(fpConfig, options.excludeScripts);
  // The only non-Chromium branch is the verified Weles Firefox release.
  const firefoxPath = findCustomBrowser('firefox');
  if (!firefoxPath) {
    throw new Error(
      `WELES_FIREFOX_BINARY_NOT_FOUND: ${customBrowserSearchHint('firefox')}`,
    );
  }
  const pwBrowser = await launchWelesFirefox({
    launchOpts,
    persona,
    nav,
    fpConfig,
    proxy: options.proxy,
  });
  try {
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
      version: pwBrowser.version(),
      launchArgs: launchOpts.args,
    });
    // The same single statement as the Chromium launcher: Playwright imposes
    // thirty seconds on every navigation and locator action unless a context
    // says otherwise. Zero is Playwright's own value for no limit:
    // https://playwright.dev/docs/api/class-browsercontext#browser-context-set-default-navigation-timeout
    context.setDefaultNavigationTimeout(0);
    // https://playwright.dev/docs/api/class-browsercontext#browser-context-set-default-timeout
    context.setDefaultTimeout(0);

    // Chrome's reduced Accept-Language leaves the header off a page's
    // same-origin subresource requests, which Firefox sends on every request;
    // a site that signs the header set (TikTok's webmssdk into x-mssdk-info)
    // sees the difference. The header is dropped where the request's origin
    // is the requesting frame's and the request is not a navigation, so a
    // cross-origin request, its CORS preflight included, keeps it.
    await context.route('**/*', async (route) => {
      const req = route.request();
      const frameUrl = req.serviceWorker() ? undefined : req.frame().url();
      const sameOrigin =
        frameUrl !== undefined &&
        URL.canParse(frameUrl) &&
        new URL(frameUrl).origin === new URL(req.url()).origin;
      if (sameOrigin && !req.isNavigationRequest()) {
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
      // Diagnostic shims are engine-agnostic (pure DOM/JS), so Firefox
      // sessions dump navigator-access traces too. A shim that cannot be read
      // fails the launch: diagnostics that were asked for are not skipped.
      for (const shim of ['property_trap.js', 'input_recorder.js']) {
        await context.addInitScript(readDiagnosticScript(shim));
        console.log(`[async_api] ${shim} installed`);
      }
      await context.addInitScript(fingerprintHooks(fpConfig));
      console.log('[async_api] fingerprint_hooks installed');
    }
    attachProtocolHandlerWatcher(context);

    const origClose = context.close.bind(context);
    context.close = async () => {
      await origClose();
      await pwBrowser.close();
    };

    return context;
  } catch (error) {
    try {
      await pwBrowser.close();
    } catch (cleanupError) {
      console.error(
        `[async_api] Firefox initialization cleanup failed: ${cleanupError}`,
      );
    }
    if (error instanceof Error) Object.assign(error, { browser_started: true });
    throw error;
  }
}
