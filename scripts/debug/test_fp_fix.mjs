import { AsyncNewBrowser } from '../../dist/async_api.js';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../dist/diagnostics/fingerprint_probe.js';
import { analyze, pickBaseline } from '../../dist/diagnostics/fingerprint_analyzer.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const chromiumPath = process.env.CHROMIUM_PATH || '/Users/lukaszbartoszcze/.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium';
console.log(`Using Chromium: ${chromiumPath}`);

const ctx = await AsyncNewBrowser({
  os: 'macos',
  browser: 'chromium',
  headless: false,
  chromiumPath,
  pageDiagnostics: false,
});
const page = ctx.pages()[0] || await ctx.newPage();

await page.goto('about:blank');
const js = await page.evaluate(FP_SCRIPT);
console.log('screen.availTop:', js.screen?.availTop);
console.log('screen.availLeft:', js.screen?.availLeft);
console.log('mediaDevices count:', js.mediaDevices?.length);
console.log('webRTC.localIPs:', js.webRTC?.localIPs);

await page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
const raw = await page.evaluate(`document.body.innerText || document.body.textContent || ''`);
const network = parseNetworkFingerprint(raw);
console.log('network.ip:', network?.ip);
console.log('network.ja4:', network?.ja4);

const payload = { capturedAt: new Date().toISOString(), source: 'weles-test', browser: 'chromium', js, network };
const baselineDir = join(process.cwd(), 'recordings', 'baselines');
let baseline = {};
if (existsSync(baselineDir)) {
  ({ data: baseline } = pickBaseline(baselineDir, payload));
}
const report = analyze(payload, baseline);
console.log('risk:', report.summary.riskScore, 'critical:', report.summary.critical, 'warning:', report.summary.warning);
for (const f of report.findings) console.log(`  ${f.severity}: ${f.id} - ${f.message}`);

await ctx.close();
