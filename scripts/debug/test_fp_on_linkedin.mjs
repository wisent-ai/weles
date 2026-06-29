import { AsyncNewBrowser } from '../../dist/async_api.js';
import { FP_SCRIPT } from '../../dist/diagnostics/fingerprint_probe.js';

const chromiumPath = process.env.CHROMIUM_PATH || '/Users/lukaszbartoszcze/.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium';
const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false, chromiumPath, pageDiagnostics: false });
const page = ctx.pages()[0] || await ctx.newPage();

await page.goto('about:blank');
const early = await page.evaluate(FP_SCRIPT);
console.log('about:blank screen.availTop:', early.screen?.availTop);
console.log('about:blank webRTC.localIPs:', early.webRTC?.localIPs);

await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));
const onLinkedIn = await page.evaluate(FP_SCRIPT);
console.log('linkedin screen.availTop:', onLinkedIn.screen?.availTop);
console.log('linkedin webRTC.localIPs:', onLinkedIn.webRTC?.localIPs);

await ctx.close();
