/**
 * LinkedIn register preflight.
 *
 * Launches the configured Weles browser and validates dedicated-ISP proxy
 * metadata/exit-IP stability without opening LinkedIn or submitting a form.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../dist/session/wsession.js';
import { findCustomBrowser } from '../../dist/session/find_browser.js';
import {
  assertLinkedinDedicatedIspProxy,
  assertLinkedinProxyStable,
  assertLinkedinRegisterProxyRequest,
  summarizeLinkedinProxyState,
} from './_shared/linkedin/register_guard.mjs';

const ACTION = 'linkedin_register_preflight';
const requestedProxy = process.env.LINKEDIN_REGISTER_PROXY ?? process.env.LINKEDIN_PROXY ?? process.env.PROXY_URL ?? 'isp decodo us';
const outDir = join(process.cwd(), 'recordings', ACTION);
const proxyResolverEvents = [];
const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
  if (line.startsWith('[proxy]')) proxyResolverEvents.push(line.slice(0, 500));
  originalConsoleLog(...args);
};

function safeRequestedProxy(value = '') {
  const raw = String(value ?? '');
  return /^(https?:|socks)/i.test(raw) ? '[url-form]' : raw.slice(0, 80);
}

function browserSnapshot(browser = process.env.WELES_BROWSER ?? 'firefox') {
  return {
    requested_browser: browser,
    custom_browser_path: findCustomBrowser(browser) ?? '',
    env: {
      WELES_FIREFOX_BIN: process.env.WELES_FIREFOX_BIN ? '[set]' : '',
      WELES_FIREFOX_DIR: process.env.WELES_FIREFOX_DIR ? '[set]' : '',
      WELES_CHROMIUM_BIN: process.env.WELES_CHROMIUM_BIN ? '[set]' : '',
      WELES_CHROMIUM_DIR: process.env.WELES_CHROMIUM_DIR ? '[set]' : '',
      WELES_ALLOW_PLAYWRIGHT_FIREFOX: process.env.WELES_ALLOW_PLAYWRIGHT_FIREFOX ?? '',
    },
  };
}

function writeSignal(signal) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'ban_signal.json'), JSON.stringify({ ...signal, ts: new Date().toISOString() }, null, 2));
}

function reasonFromError(errorMessage = '') {
  const resolverText = proxyResolverEvents.join('\n');
  if (/Executable doesn't exist|browserType\.launch|WELES_FIREFOX_BINARY_NOT_FOUND|playwright install|missing.*browser|Nightly\.app/i.test(errorMessage)) {
    return { code: 'browser_launch_failed', message: errorMessage.slice(0, 240) };
  }
  if (/linkedin-probe .* -> challenge/i.test(resolverText)) {
    const exitIps = [...resolverText.matchAll(/exit=([0-9a-fA-F:.]+)/g)].map((m) => m[1]);
    const uniqueIps = [...new Set(exitIps)].join(',');
    return {
      code: 'linkedin_proxy_preflight_challenge',
      message: `LinkedIn login probe returned challenge for exit_ip=${uniqueIps || 'unknown'}`,
    };
  }
  if (/proxy_unavailable/i.test(errorMessage)) return { code: 'proxy_unavailable', message: errorMessage.slice(0, 240) };
  if (/PROXY_NOT_DEDICATED_ISP/.test(errorMessage)) return { code: 'proxy_not_dedicated_isp', message: errorMessage.slice(0, 240) };
  if (/PROXY_DRIFT_CHECK_FAILED/.test(errorMessage)) return { code: 'proxy_drift_probe_failed', message: errorMessage.slice(0, 240) };
  if (/PROXY_DRIFT:/.test(errorMessage)) return { code: 'proxy_exit_ip_drift', message: errorMessage.slice(0, 240) };
  return { code: 'preflight_failed', message: errorMessage.slice(0, 240) };
}

const stageEvents = [];
let session = null;
let expectedExitIp = '';

function recordStage(stage, data = {}) {
  stageEvents.push({
    ts: new Date().toISOString(),
    stage,
    url: session?.page?.url?.() ?? '',
    ...data,
  });
}

try {
  recordStage('proxy_request_received', { requested_proxy: safeRequestedProxy(requestedProxy), browser: browserSnapshot() });
  assertLinkedinRegisterProxyRequest(requestedProxy);
  recordStage('proxy_request_validated', { requested_proxy: safeRequestedProxy(requestedProxy) });

  session = await WSession.start({ label: ACTION, proxy: requestedProxy, targetHost: 'www.linkedin.com', platform: 'linkedin' });
  recordStage('session_started', { browser: browserSnapshot(session.browserName ?? process.env.WELES_BROWSER ?? 'firefox') });

  expectedExitIp = session.proxyConfig?.exit_ip ?? '';
  assertLinkedinDedicatedIspProxy(session, requestedProxy);
  recordStage('proxy_metadata_validated', { proxy: summarizeLinkedinProxyState(session, requestedProxy, expectedExitIp) });

  expectedExitIp = await assertLinkedinProxyStable(session, 'preflight', expectedExitIp);
  recordStage('proxy_stable_preflight', { proxy: summarizeLinkedinProxyState(session, requestedProxy, expectedExitIp) });

  writeSignal({
    action: ACTION,
    signal: 'healthy',
    healthy: true,
    details: {
      diagnostics: {
        browser: browserSnapshot(session.browserName ?? process.env.WELES_BROWSER ?? 'firefox'),
        proxy: summarizeLinkedinProxyState(session, requestedProxy, expectedExitIp),
        proxy_resolver_events: proxyResolverEvents,
      },
      failure_reasons: [],
      stage_events: stageEvents,
    },
  });
  console.log('PASS: linkedin_register_preflight');
} catch (e) {
  const errorMessage = e.message ?? '';
  recordStage('failure_classified', { error: errorMessage.slice(0, 200) });
  writeSignal({
    action: ACTION,
    signal: 'preflight_failed',
    healthy: false,
    details: {
      final_url: session?.page?.url?.() ?? '',
      error: errorMessage.slice(0, 300),
      diagnostics: {
        browser: browserSnapshot(session?.browserName ?? process.env.WELES_BROWSER ?? 'firefox'),
        proxy: session ? summarizeLinkedinProxyState(session, requestedProxy, expectedExitIp) : { requested: safeRequestedProxy(requestedProxy) },
        proxy_resolver_events: proxyResolverEvents,
      },
      failure_reasons: [reasonFromError(errorMessage)],
      stage_events: stageEvents,
    },
  });
  console.log(`FAIL: ${errorMessage.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await session?.close?.();
}
