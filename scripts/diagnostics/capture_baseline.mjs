#!/usr/bin/env node
// Capture real-browser baseline fingerprints for the detection-vector analyzer.
//
// Supports Google Chrome (Playwright channel: chrome) and system Firefox.
// Captures the same JS probe + TLS fingerprint that the Weles capture script
// uses, so subject-vs-baseline diffs are apples-to-apples.
//
// Usage:
//   node scripts/diagnostics/capture_baseline.mjs [chrome|firefox]
//   BASELINE_OUT=recordings/baselines node scripts/diagnostics/capture_baseline.mjs firefox
//
// Output file: <outDir>/<browser>_<os>_<timestamp>.json

import { chromium, firefox } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../dist/diagnostics/fingerprint_probe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const browserName = process.argv[2] || process.env.BASELINE_BROWSER || 'chrome';
const outDir = process.env.BASELINE_OUT || join(ROOT, 'recordings', 'baselines');
const headless = process.env.HEADLESS === '1';

function osFromUA(ua) {
  const u = ua.toLowerCase();
  if (u.includes('macintosh') || u.includes('mac os')) return 'macos';
  if (u.includes('windows nt')) return 'windows';
  if (u.includes('linux') || u.includes('x11')) return 'linux';
  return 'unknown';
}

async function captureChrome() {
  const browser = await chromium.launch({ channel: 'chrome', headless });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  return { browser, page };
}

async function captureFirefox() {
  const ffPath = process.env.FIREFOX_PATH || (
    process.platform === 'darwin'
      ? '/Applications/Firefox.app/Contents/MacOS/firefox'
      : '/usr/bin/firefox'
  );
  const browser = await firefox.launch({ executablePath: ffPath, headless });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  return { browser, page };
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  console.log(`[baseline] launching ${browserName} (headless=${headless})...`);
  const launcher = browserName === 'firefox' ? captureFirefox : captureChrome;
  const { browser, page } = await launcher();

  try {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    const js = await page.evaluate(FP_SCRIPT);

    await page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded' });
    const raw = await page.evaluate(`document.body.innerText || document.body.textContent || ''`);
    const network = parseNetworkFingerprint(raw);

    const os = osFromUA(js?.navigator?.userAgent || '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${browserName}_${os}_${ts}.json`;
    const filePath = join(outDir, fileName);

    const payload = {
      capturedAt: new Date().toISOString(),
      source: `baseline-${browserName}`,
      browser: browserName,
      os,
      js,
      network,
    };

    writeFileSync(filePath, JSON.stringify(payload, null, 2));
    console.log(`[baseline] saved ${filePath}`);
    console.log(`[baseline] UA=${js?.navigator?.userAgent}`);
    console.log(`[baseline] renderer=${js?.webgl?.unmaskedRenderer}`);
    console.log(`[baseline] ja4=${network?.ja4}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[baseline] fatal:', e);
  process.exit(1);
});
