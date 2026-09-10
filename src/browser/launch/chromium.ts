import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { ChildProcess, execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type BrowserContext, type BrowserContextOptions } from 'playwright';
import { toCppConfig } from '../../fingerprint.js';
import { runRecordingsDir } from '../../session/run-recordings.js';
import { buildChromiumSupplementScripts } from '../../page-init/loader.js';
import { browserProvenance, chromiumNetlogConfig, redactContextOpts, attachProtocolHandlerWatcher, readDiagnosticScript } from './support.js';
import type { ContextLaunchInput } from './support.js';
import { WEBAUTHN_REJECT_SCRIPT, ARKOSE_OBSERVER_SCRIPT, FETCH_REGISTER_INTERCEPT_SCRIPT, MODERN_API_HOOKS_SCRIPT, SURFACE_INVENTORY_SCRIPT } from './init_scripts.js';

export async function launchChromiumContext(input: ContextLaunchInput & {
  args: string[]; chromiumPath: string; targetOs: string; captureHar: boolean;
}): Promise<BrowserContext> {
  const { options, fpConfig, ctxOpts, launchOpts, pageDiagnostics, browserType, args, chromiumPath, targetOs, captureHar } = input;
  const headless = launchOpts.headless;
  const recordVideo = Boolean(ctxOpts.recordVideo);
  const { width: viewW, height: viewH } = ctxOpts.viewport;
  const dpr = ctxOpts.deviceScaleFactor;
  const userDataDir = options.userDataDir ?? process.env.WELES_USER_DATA_DIR ?? '';
  let realizedFingerprint: unknown = fpConfig;
    launchOpts.executablePath = chromiumPath;
    const cppConfig = toCppConfig(fpConfig, targetOs, { chromiumPath });
    // Honest OS version: replace toCppConfig's default platformVersion with the
    // real host's (Phase 1 reports OS version truthfully). Explicit audit pins
    // still win so the Chrome-vs-Weles harness can compare equal surfaces.
    const _hh = fpConfig._honestHost;
    const pinnedPlatformVersion = process.env.WELES_CLIENT_HINTS_PLATFORM_VERSION || process.env.WELES_MAC_PLATFORM_VERSION;
    const pinnedArchitecture = process.env.WELES_CLIENT_HINTS_ARCHITECTURE;
    if (cppConfig.clientHints) {
      if (pinnedPlatformVersion) cppConfig.clientHints.platformVersion = pinnedPlatformVersion;
      else if (_hh?.platformVersion) cppConfig.clientHints.platformVersion = _hh.platformVersion;
      if (pinnedArchitecture) cppConfig.clientHints.architecture = pinnedArchitecture;
    }
    fpConfig.clientHints = cppConfig.clientHints;
    if (cppConfig.clientHints) {
      fpConfig.navigator.platformVersion = cppConfig.clientHints.platformVersion;
      fpConfig.navigator.architecture = cppConfig.clientHints.architecture;
      fpConfig.navigator.bitness = cppConfig.clientHints.bitness;
    }
    realizedFingerprint = cppConfig;
    // Resolve every required asset before launching a browser.
    const initScripts = buildChromiumSupplementScripts(fpConfig);
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
    const possibleProcess: unknown = pwBrowser && 'process' in pwBrowser && typeof pwBrowser.process === 'function' ? pwBrowser.process() : undefined;
    const proc = possibleProcess instanceof ChildProcess ? possibleProcess : undefined;
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
    const customCtxOpts: BrowserContextOptions = { viewport: { width: viewW, height: viewH }, deviceScaleFactor: dpr };
    if (ctxOpts.proxy) { customCtxOpts.proxy = ctxOpts.proxy; customCtxOpts.ignoreHTTPSErrors = true; }
    if (ctxOpts.recordVideo) customCtxOpts.recordVideo = ctxOpts.recordVideo;
    if (ctxOpts.extraHTTPHeaders) customCtxOpts.extraHTTPHeaders = ctxOpts.extraHTTPHeaders;
    if (ctxOpts.acceptDownloads === false) customCtxOpts.acceptDownloads = false;
    if (ctxOpts.serviceWorkers === 'block') customCtxOpts.serviceWorkers = 'block';
    if (captureHar && process.env.WELES_LABEL) customCtxOpts.recordHar = { path: join(runRecordingsDir(process.env.WELES_LABEL), 'session.har'), content: 'embed', mode: 'full' }; // G17: recordings/<run_uuid>/<label>/session.har — sealed at context.close. Decoupled from pageDiagnostics: HAR is CDP-level, not page-visible.
    console.log(`[async_api] Context opts: ${JSON.stringify(redactContextOpts({ ...customCtxOpts, ...(persistentProfile ? { userDataDir: persistentProfile } : {}) }))}`);
    let created: BrowserContext | undefined;
    try {
    const context = persistentProfile
      ? await chromium.launchPersistentContext(persistentProfile, { ...launchOpts, ...customCtxOpts })
      : await pwBrowser!.newContext(customCtxOpts);
    created = context;
    // G1 fix: the custom-Chromium branch returns before the shared attach point
    // below, so attach the realized fingerprint here too — otherwise the
    // production path silently drops result.session.realized_fingerprint.
    const provenance = browserProvenance({
      browserType,
      source: persistentProfile ? 'custom-chromium-persistent' : 'custom-chromium',
      executablePath: chromiumPath,
      pid,
      customBinary: true,
      stockOverride: false,
      version: (() => { try { return (pwBrowser ?? context.browser())?.version() ?? null; } catch { return null; } })(),
      launchArgs: args,
    });
    if (persistentProfile) Object.assign(provenance, { user_data_dir: persistentProfile });
    Object.assign(context, { _welesFingerprintConfig: realizedFingerprint, _welesBrowserProvenance: provenance });
    context.setDefaultNavigationTimeout(0);
    console.log(`[async_api] Context created`);
    const origClose = context.close.bind(context);
    context.close = async () => {
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
        const tag = fpDir.split('/').pop(); // e.g. weles-fp-Pf0jrD — unique per run
        if (tag) await new Promise<void>(res => execFile('pkill', ['-f', tag], () => res()));
      } catch { /* pkill unavailable / nothing to kill */ }
      try { rmSync(fpDir, { recursive: true, force: true }); } catch { /* already gone */ }
    };
    // Init-script injections. Chrome 147 stubs are fingerprint-parity shims;
    // page diagnostics are disabled for sensitive flows such as LinkedIn
    // register because wrappers/traps are visible to page JavaScript.
    for (const script of initScripts) await context.addInitScript(script);
    const injectDiagnostic = async (name: string) => {
      try { await context.addInitScript(readDiagnosticScript(name)); }
      catch (error) { console.log(`[async_api] ${name} install failed: ${(error as Error).message}`); }
    };
    if (pageDiagnostics) {
      await injectDiagnostic('property_trap.js');
      await injectDiagnostic('input_recorder.js');
      await context.addInitScript(WEBAUTHN_REJECT_SCRIPT);
      await context.addInitScript(ARKOSE_OBSERVER_SCRIPT);
      await context.addInitScript(FETCH_REGISTER_INTERCEPT_SCRIPT);
      await context.addInitScript(MODERN_API_HOOKS_SCRIPT);
      await context.addInitScript(SURFACE_INVENTORY_SCRIPT);
    }
    attachProtocolHandlerWatcher(context);
    return context;
    } catch (error) {
      try {
        if (created) await created.close();
        else await pwBrowser?.close();
      } catch (cleanupError) {
        console.error(`[async_api] Chromium initialization cleanup failed: ${cleanupError}`);
      }
      rmSync(fpDir, { recursive: true, force: true });
      if (error instanceof Error) Object.assign(error, { browser_started: Boolean(created || pwBrowser) || null });
      throw error;
    }
}
