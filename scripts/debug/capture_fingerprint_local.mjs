// Capture comprehensive fingerprint from our weles Chromium.
// Uses shared probe from dist/diagnostics/fingerprint_probe.js so any new
// measurement added to the probe shows up here automatically. Output is a
// combined JSON: { js: <FP_SCRIPT output>, network: <tls.peet.ws output> }.
//
// Diff the output JSON against `recordings/real_chrome_fingerprint.json`
// (captured via the Playwright `channel: chrome` path) to find remaining
// weles-specific fingerprint leaks.
//
// Usage: CHROMIUM_PATH=... node --env-file=.env scripts/debug/capture_fingerprint_local.mjs
import { WSession } from '../../dist/session/wsession.js';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../dist/diagnostics/fingerprint_probe.js';
import { writeFileSync } from 'node:fs';

delete process.env.BRIGHTDATA_BROWSER_WS;
const s = await WSession.start({ label: 'fingerprint_local', proxy: process.env.PROBE_PROXY || 'none', record: false });

let js = null, network = null;
try {
  await s.goto('about:blank');
  js = await s.page.evaluate(FP_SCRIPT);

  // Network-level capture via tls.peet.ws (cross-origin JSON; goto it directly)
  await s.page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded' });
  const raw = await s.page.evaluate(`document.body.innerText || document.body.textContent || ''`);
  network = parseNetworkFingerprint(raw);
} finally {
  await s.close();
}

const out = { capturedAt: new Date().toISOString(), source: 'weles-local', js, network };
const path = 'recordings/local_fingerprint.json';
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`Saved to ${path}`);
console.log(`summary: canvas.toDataURLLen=${out.js?.canvas?.toDataURLLen} speechVoices.count=${out.js?.speechVoices?.count} ja4=${out.network?.ja4}`);
