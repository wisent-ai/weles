import type { BrowserContext } from 'playwright';
import { buildInitScript } from '../../page-init/loader.js';
import { findCustomBrowser } from '../../session/find_browser.js';
import { launchWelesFirefox } from './firefox_launch.js';
import { browserProvenance, attachProtocolHandlerWatcher, readDiagnosticScript } from './support.js';
import type { ContextLaunchInput } from './support.js';
import { WEBAUTHN_REJECT_SCRIPT, ARKOSE_OBSERVER_SCRIPT_STOCK, FETCH_REGISTER_INTERCEPT_SCRIPT } from './init_scripts.js';

export async function launchFirefoxContext(input: ContextLaunchInput): Promise<BrowserContext> {
  const { options, fpConfig, ctxOpts, launchOpts, pageDiagnostics, browserType } = input;
  const persona = options.persona;
  const nav = fpConfig.navigator ?? {};
  const isChromium = false;
  const realizedFingerprint = fpConfig;
  const initScript = buildInitScript(fpConfig, options.excludeScripts);
  // The only non-Chromium branch is the verified Weles Firefox release.
  const firefoxPath = findCustomBrowser('firefox');
  if (!firefoxPath) {
    throw new Error('WELES_FIREFOX_BINARY_NOT_FOUND: install the configured immutable Stado release');
  }
  const pwBrowser = await launchWelesFirefox({ launchOpts, persona, nav, fpConfig, proxy: options.proxy });
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
    customBinary: true,
    stockOverride: false,
    version: (() => { try { return pwBrowser.version(); } catch { return null; } })(),
  });
  context.setDefaultNavigationTimeout(0);

  // Strip Accept-Language on TikTok same-origin sub-requests (Chrome 147 default-on ReduceAcceptLanguage omits it; weles emits unconditionally; webmssdk signs into x-mssdk-info). EXCEPTION: passport/web/* CORS preflight needs it.
  await context.route('**/*', async route => {
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
    for (const f of ['property_trap.js', 'input_recorder.js']) { try { await context.addInitScript(readDiagnosticScript(f)); console.log(`[async_api] ${f.split('.')[0]} installed`); } catch (e) { console.log(`[async_api] ${f} install failed: ${(e as Error).message}`); } }
    try { let _fh = readDiagnosticScript('fingerprint_hooks.js'); if (persona && !isChromium) { const gl = fpConfig.webgl ?? {}; _fh = _fh.replace(/__WELES_GL_VENDOR__/g, gl.unmaskedVendor || gl.vendor || 'Mozilla').replace(/__WELES_GL_RENDERER__/g, gl.unmaskedRenderer || gl.renderer || ''); } await context.addInitScript(_fh); console.log('[async_api] fingerprint_hooks installed'); } catch (e) { console.log(`[async_api] fingerprint_hooks install failed: ${(e as Error).message}`); }
  }
  attachProtocolHandlerWatcher(context);

  const origClose = context.close.bind(context);
  context.close = async () => { await origClose(); await pwBrowser.close(); };

  return context;
  } catch (error) {
    try { await pwBrowser.close(); }
    catch (cleanupError) { console.error(`[async_api] Firefox initialization cleanup failed: ${cleanupError}`); }
    if (error instanceof Error) Object.assign(error, { browser_started: true });
    throw error;
  }
}
