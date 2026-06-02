// Side-by-side browser fingerprint audit.
//
// Default target is loopback + tls.peet.ws, not LinkedIn. Run this on the same
// host that runs Weles workers when auditing runtime coherence.
//
// Usage:
//   npm run build
//   node --env-file=.env scripts/debug/audit_chrome_vs_weles.mjs
//
// Optional env:
//   AUDIT_TARGET_URL=https://example.com       navigate after fingerprint capture
//   AUDIT_SKIP_NETWORK=1                       skip tls.peet.ws network capture
//   AUDIT_CHROME_CHANNEL=chrome|chromium       Playwright channel for baseline
//   AUDIT_CHROME_PATH=/Applications/...        exact real Chrome/Chromium binary for baseline
//   AUDIT_EXPECT_CHROME_MAJOR=147              expected baseline major version
//   AUDIT_EXPECT_WELES_MAJOR=147               expected Weles major version
//   AUDIT_HEADLESS=1                           run baseline Chrome headless for CI/non-interactive probes
//   AUDIT_TIMEOUT_MS=30000                     per-navigation/browser-operation timeout
//   AUDIT_FP_TIMEOUT_MS=15000                  JS fingerprint probe timeout
//   AUDIT_PROXY_SERVER=http://host:port        proxy for baseline Chrome
//   LINKEDIN_PROXY_COUNTRY=US                  Weles persona country
//   WELES_CLIENT_HINTS_PLATFORM_VERSION=15.6.1 pin macOS client hints

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../dist/diagnostics/fingerprint_probe.js';

const OUT_DIR = 'recordings/audits';
mkdirSync(OUT_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const targetUrl = process.env.AUDIT_TARGET_URL || '';
const skipNetwork = process.env.AUDIT_SKIP_NETWORK === '1';
const chromeChannel = process.env.AUDIT_CHROME_CHANNEL || 'chrome';
const chromePath = process.env.AUDIT_CHROME_PATH || '';
const expectedChromeMajor = process.env.AUDIT_EXPECT_CHROME_MAJOR || '147';
const expectedWelesMajor = process.env.AUDIT_EXPECT_WELES_MAJOR || '147';
const headless = process.env.AUDIT_HEADLESS === '1';
const timeoutMs = Number(process.env.AUDIT_TIMEOUT_MS || 30_000);
const fpTimeoutMs = Number(process.env.AUDIT_FP_TIMEOUT_MS || 15_000);
const exactProxyRequired = process.env.AUDIT_REQUIRE_EXACT_PROXY !== '0';
const sharedPersona = generatePersona({
  country: process.env.LINKEDIN_PROXY_COUNTRY || process.env.WELES_PROXY_COUNTRY || 'US',
  os: 'macos',
  browser: 'chromium',
});

const loopback = createServer((req, res) => {
  if (req.url === '/headers') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, headers: req.headers }, null, 2));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head><title>weles audit</title></head><body>weles audit</body></html>');
});
await new Promise(resolve => loopback.listen(0, '127.0.0.1', resolve));
const loopbackUrl = `http://127.0.0.1:${loopback.address().port}/`;
const headersUrl = `http://127.0.0.1:${loopback.address().port}/headers`;

function stableJson(value) {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, null, 2);
}

function pickSummary(capture) {
  const js = capture.js || {};
  const nav = js.navigator || {};
  const uad = js.userAgentData || {};
  const webgl = js.webgl1?.params || {};
  return {
    source: capture.source,
    userAgent: nav.userAgent,
    platform: nav.platform,
    webdriver: nav.webdriver,
    languages: nav.languages,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    userAgentData: {
      brands: uad.brands,
      platform: uad.platform,
      architecture: uad.architecture,
      platformVersion: uad.platformVersion,
      fullVersionList: uad.fullVersionList,
    },
    screen: js.screen,
    window: js.window,
    webgl: {
      vendor: webgl.UNMASKED_VENDOR,
      renderer: webgl.UNMASKED_RENDERER,
      version: webgl.VERSION,
    },
    canvas: js.canvas,
    audio: js.audio,
    intl: js.intl,
    permissions: js.permissions,
    mediaDevices: js.mediaDevices,
    speechVoices: js.speechVoices,
    chrome: js.chrome,
    distinctivePropsHits: js.distinctivePropsHits,
    network: capture.network ? {
      ja4: capture.network.ja4,
      ja3_hash: capture.network.ja3_hash,
      peetprint_hash: capture.network.peetprint_hash,
      akamaiH2: capture.network.akamaiH2,
      ip: capture.network.ip,
      userAgent: capture.network.userAgent,
      headers: capture.network.headers,
    } : null,
    loopbackHeaders: capture.loopbackHeaders,
  };
}

function parseChromeMajor(value) {
  const m = String(value ?? '').match(/(?:Chrome|Chromium)\/(\d+)\./i) || String(value ?? '').match(/^(\d+)\./);
  return m ? m[1] : null;
}

function hashValue(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function proxyConfigured(value) {
  return !!value && value !== 'direct';
}

function extractVersion(capture) {
  return capture?.js?.navigator?.userAgent
    || capture?.sessionMeta?.browser_version
    || capture?.browserVersion
    || null;
}

async function captureBrowserVersion(browser) {
  try {
    return await browser.version();
  } catch {
    return null;
  }
}

function diffObjects(a, b, path = '') {
  const diffs = [];
  if (Object.is(a, b)) return diffs;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    diffs.push({ path: path || '$', chrome: a, weles: b });
    return diffs;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort()) {
    diffs.push(...diffObjects(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return diffs;
}

async function captureNetwork(page) {
  if (skipNetwork) return null;
  await page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 60_000) });
  const raw = await page.evaluate(`document.body.innerText || document.body.textContent || ''`);
  return parseNetworkFingerprint(raw);
}

async function captureLoopbackHeaders(page) {
  await page.goto(headersUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const raw = await page.evaluate(`document.body.innerText || document.body.textContent || ''`);
  try { return JSON.parse(raw).headers || null; } catch { return { _err: raw.slice(0, 200) }; }
}

async function evaluateFingerprint(page) {
  return await page.evaluate(
    ({ script, timeout }) => {
      return Promise.race([
        eval(script),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`fingerprint_probe_timeout_${timeout}ms`)), timeout)),
      ]);
    },
    { script: FP_SCRIPT, timeout: fpTimeoutMs },
  );
}

async function captureWeles() {
  const s = await WSession.start({
    label: 'audit_weles',
    proxy: process.env.PROBE_PROXY || 'direct',
    persona: sharedPersona,
    injectStorage: false,
    record: false,
    codecShim: false,
    passkeyStub: false,
    arkoseCapture: false,
    authFetchCapture: false,
    pageInstrumentation: false,
    });
  try {
    await s.goto(loopbackUrl);
    const js = await evaluateFingerprint(s.page);
    const loopbackHeaders = await captureLoopbackHeaders(s.page);
    const network = await captureNetwork(s.page);
    if (targetUrl) await s.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 60_000) }).catch(() => {});
    return { capturedAt: new Date().toISOString(), source: 'weles', persona: sharedPersona, sessionMeta: s.sessionMeta ?? null, js, loopbackHeaders, network };
  } finally {
    await s.close();
  }
}

async function captureChrome() {
  const launchOpts = { headless, timeout: timeoutMs };
  if (chromePath) {
    if (!existsSync(chromePath)) {
      throw new Error(`AUDIT_CHROME_PATH does not exist: ${chromePath}`);
    }
    launchOpts.executablePath = chromePath;
  } else {
    launchOpts.channel = chromeChannel;
  }
  if (process.env.AUDIT_PROXY_SERVER) {
    launchOpts.proxy = { server: process.env.AUDIT_PROXY_SERVER };
  }
  const browser = await chromium.launch(launchOpts);
  try {
    const browserVersion = await captureBrowserVersion(browser);
    const ctx = await browser.newContext({
      locale: sharedPersona.language,
      timezoneId: sharedPersona.timezone,
      viewport: { width: sharedPersona.screen.width, height: sharedPersona.screen.height },
      deviceScaleFactor: sharedPersona.screen.dpr,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    await page.goto(loopbackUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const js = await evaluateFingerprint(page);
    const loopbackHeaders = await captureLoopbackHeaders(page);
    const network = await captureNetwork(page);
    if (targetUrl) await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 60_000) }).catch(() => {});
    return {
      capturedAt: new Date().toISOString(),
      source: chromePath ? 'chrome-executable-path' : `chrome-channel-${chromeChannel}`,
      launch: {
        channel: chromePath ? null : chromeChannel,
        executablePath: chromePath || null,
        proxy: process.env.AUDIT_PROXY_SERVER ? 'configured' : 'direct',
        headless,
      },
      browserVersion,
      js,
      loopbackHeaders,
      network,
    };
  } finally {
    await browser.close();
  }
}

function assessComparability(chromeCapture, welesCapture) {
  const checks = [];
  const chromeVersion = extractVersion(chromeCapture);
  const welesVersion = extractVersion(welesCapture);
  const chromeMajor = parseChromeMajor(chromeVersion);
  const welesMajor = parseChromeMajor(welesVersion);
  checks.push({
    id: 'baseline_binary_selected',
    ok: !!chromePath,
    detail: chromePath ? `AUDIT_CHROME_PATH=${chromePath}` : `using Playwright channel ${chromeChannel}`,
  });
  checks.push({
    id: 'baseline_major_version',
    ok: chromeMajor === expectedChromeMajor,
    expected: expectedChromeMajor,
    observed: chromeMajor,
    detail: chromeVersion,
  });
  checks.push({
    id: 'weles_major_version',
    ok: welesMajor === expectedWelesMajor,
    expected: expectedWelesMajor,
    observed: welesMajor,
    detail: welesVersion,
  });
  checks.push({
    id: 'same_major_version',
    ok: !!chromeMajor && chromeMajor === welesMajor,
    chromeMajor,
    welesMajor,
  });
  checks.push({
    id: 'same_network_path_configured',
    ok: (process.env.AUDIT_PROXY_SERVER || 'direct') === (process.env.PROBE_PROXY || 'direct')
      && (!exactProxyRequired || (proxyConfigured(process.env.AUDIT_PROXY_SERVER) && proxyConfigured(process.env.PROBE_PROXY))),
    chromeProxy: process.env.AUDIT_PROXY_SERVER ? 'configured' : 'direct',
    welesProxy: process.env.PROBE_PROXY ? 'configured' : 'direct',
    exactProxyRequired,
    detail: 'Set AUDIT_PROXY_SERVER and PROBE_PROXY to the same exact proxy when auditing LinkedIn parity.',
  });
  const chromeNetworkIpHash = hashValue(chromeCapture?.network?.ip);
  const welesNetworkIpHash = hashValue(welesCapture?.network?.ip);
  checks.push({
    id: 'same_observed_network_exit',
    ok: !!chromeNetworkIpHash && chromeNetworkIpHash === welesNetworkIpHash,
    chrome_ip_hash: chromeNetworkIpHash,
    weles_ip_hash: welesNetworkIpHash,
    detail: skipNetwork ? 'network probe skipped' : 'tls.peet.ws reported IP hashes must match',
  });
  const chromeTz = chromeCapture?.js?.intl?.timezone ?? chromeCapture?.js?.intl?.dateTimeFormat?.timeZone;
  const welesTz = welesCapture?.js?.intl?.timezone ?? welesCapture?.js?.intl?.dateTimeFormat?.timeZone;
  checks.push({
    id: 'same_timezone',
    ok: !!chromeTz && chromeTz === welesTz,
    chrome: chromeTz ?? null,
    weles: welesTz ?? null,
  });
  const chromeLocale = chromeCapture?.js?.navigator?.language || chromeCapture?.js?.navigator?.languages?.[0];
  const welesLocale = welesCapture?.js?.navigator?.language || welesCapture?.js?.navigator?.languages?.[0];
  checks.push({
    id: 'same_primary_locale',
    ok: !!chromeLocale && chromeLocale === welesLocale,
    chrome: chromeLocale ?? null,
    weles: welesLocale ?? null,
  });
  const chromeViewport = chromeCapture?.js?.window
    ? {
      innerWidth: chromeCapture.js.window.innerWidth,
      innerHeight: chromeCapture.js.window.innerHeight,
      devicePixelRatio: chromeCapture.js.window.devicePixelRatio,
    }
    : null;
  const welesViewport = welesCapture?.js?.window
    ? {
      innerWidth: welesCapture.js.window.innerWidth,
      innerHeight: welesCapture.js.window.innerHeight,
      devicePixelRatio: welesCapture.js.window.devicePixelRatio,
    }
    : null;
  checks.push({
    id: 'same_viewport',
    ok: !!chromeViewport && !!welesViewport
      && chromeViewport.innerWidth === welesViewport.innerWidth
      && chromeViewport.innerHeight === welesViewport.innerHeight
      && chromeViewport.devicePixelRatio === welesViewport.devicePixelRatio,
    chrome: chromeViewport,
    weles: welesViewport,
    expected_persona_screen: sharedPersona.screen,
  });
  const chromeScreen = chromeCapture?.js?.screen
    ? { width: chromeCapture.js.screen.width, height: chromeCapture.js.screen.height, colorDepth: chromeCapture.js.screen.colorDepth }
    : null;
  const welesScreen = welesCapture?.js?.screen
    ? { width: welesCapture.js.screen.width, height: welesCapture.js.screen.height, colorDepth: welesCapture.js.screen.colorDepth }
    : null;
  checks.push({
    id: 'same_screen_surface',
    ok: !!chromeScreen && !!welesScreen
      && chromeScreen.width === welesScreen.width
      && chromeScreen.height === welesScreen.height
      && chromeScreen.colorDepth === welesScreen.colorDepth,
    chrome: chromeScreen,
    weles: welesScreen,
    detail: 'Screen surface should match the shared persona; viewport alone is not enough for LinkedIn parity.',
  });
  checks.push({
    id: 'same_target_surface',
    ok: true,
    target_url: targetUrl || null,
    loopback_url_used: true,
    network_probe_used: !skipNetwork,
    detail: 'Both browsers run the same loopback, optional target, and optional tls.peet.ws probes in this harness.',
  });
  const validity = checks.every((c) => c.ok);
  return {
    valid_linkedin_baseline: validity,
    checks,
    blockers: checks.filter((c) => !c.ok).map((c) => c.id),
  };
}

let chromeCapture;
let welesCapture;
try {
  chromeCapture = await captureChrome();
} catch (e) {
  chromeCapture = {
    capturedAt: new Date().toISOString(),
    source: chromePath ? 'chrome-executable-path' : `chrome-channel-${chromeChannel}`,
    launch: {
      channel: chromePath ? null : chromeChannel,
      executablePath: chromePath || null,
      proxy: process.env.AUDIT_PROXY_SERVER ? 'configured' : 'direct',
      headless,
    },
    error: String(e.message || e),
  };
}
try {
  welesCapture = await captureWeles();
} catch (e) {
  welesCapture = { capturedAt: new Date().toISOString(), source: 'weles', error: String(e.message || e) };
}
loopback.close();

const chromeSummary = chromeCapture.error ? chromeCapture : pickSummary(chromeCapture);
const welesSummary = welesCapture.error ? welesCapture : pickSummary(welesCapture);
const summaryDiff = chromeCapture.error || welesCapture.error ? [] : diffObjects(chromeSummary, welesSummary);
const comparability = chromeCapture.error || welesCapture.error
  ? { valid_linkedin_baseline: false, blockers: ['capture_error'], checks: [] }
  : assessComparability(chromeCapture, welesCapture);
const out = {
  capturedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    chromeChannel,
    chromePath: chromePath || null,
    expectedChromeMajor,
    expectedWelesMajor,
    headless,
    timeoutMs,
    fpTimeoutMs,
    sharedPersona: {
      os: sharedPersona.os,
      browser: sharedPersona.browser,
      language: sharedPersona.language,
      timezone: sharedPersona.timezone,
      platform: sharedPersona.platform,
      screen: sharedPersona.screen,
      gpu: sharedPersona.gpu,
    },
    envPins: {
      WELES_CLIENT_HINTS_PLATFORM_VERSION: process.env.WELES_CLIENT_HINTS_PLATFORM_VERSION || null,
      WELES_MAC_PLATFORM_VERSION: process.env.WELES_MAC_PLATFORM_VERSION || null,
      WELES_CLIENT_HINTS_ARCHITECTURE: process.env.WELES_CLIENT_HINTS_ARCHITECTURE || null,
    },
  },
  chrome: chromeCapture,
  weles: welesCapture,
  summaries: { chrome: chromeSummary, weles: welesSummary },
  comparability,
  summaryDiff,
};

const outPath = join(OUT_DIR, `chrome_vs_weles_${ts}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Saved ${outPath}`);
console.log(`Chrome error: ${chromeCapture.error || 'none'}`);
console.log(`Weles error: ${welesCapture.error || 'none'}`);
console.log(`Valid LinkedIn baseline: ${comparability.valid_linkedin_baseline}`);
if (comparability.blockers?.length) console.log(`Baseline blockers: ${comparability.blockers.join(', ')}`);
console.log(`Summary diff count: ${summaryDiff.length}`);
for (const d of summaryDiff.slice(0, 40)) {
  console.log(`- ${d.path}: chrome=${stableJson(d.chrome).slice(0, 180)} weles=${stableJson(d.weles).slice(0, 180)}`);
}
