// Capture comprehensive fingerprint from Bright Data's reference Chrome.
// Same probe + network capture as capture_fingerprint_local.mjs, so the two
// outputs can be diffed directly to find weles-specific fingerprint leaks.
//
// Uses the dedicated Bright Data Browser Skarbiec credential.
import { chromium } from 'playwright';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../dist/diagnostics/fingerprint_probe.js';
import { writeFileSync } from 'node:fs';
import { readScopedSecret } from '../_shared/scoped-secrets.mjs';

const ws = readScopedSecret('brightdataBrowser', 'websocket_url');

console.log('Connecting to Bright Data...');
const browser = await chromium.connectOverCDP(ws);
const ctx = browser.contexts()[0] || await browser.newContext();
const page = ctx.pages()[0] || await ctx.newPage();

let js = null, network = null;
try {
  await page.goto('about:blank');
  js = await page.evaluate(FP_SCRIPT);

  await page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded' });
  const raw = await page.evaluate(`document.body.innerText || document.body.textContent || ''`);
  network = parseNetworkFingerprint(raw);
} finally {
  await browser.close();
}

const out = { capturedAt: new Date().toISOString(), source: 'brightdata', js, network };
const path = 'recordings/brightdata_fingerprint.json';
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`Saved to ${path}`);
console.log(`summary: canvas.toDataURLLen=${out.js?.canvas?.toDataURLLen} speechVoices.count=${out.js?.speechVoices?.count} ja4=${out.network?.ja4}`);
