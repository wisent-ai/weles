import { AsyncNewBrowser } from '../../dist/async_api.js';
import { NETWORK_FP_URL, parseNetworkFingerprint } from '../../dist/diagnostics/fingerprint_probe.js';

const chromiumPath = process.env.CHROMIUM_PATH || '/Users/lukaszbartoszcze/.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium';
const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false, chromiumPath, pageDiagnostics: false });
const page = ctx.pages()[0] || await ctx.newPage();

async function capture(label) {
  await page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const raw = await page.evaluate(`document.body.innerText || document.body.textContent || ''`);
  const net = parseNetworkFingerprint(raw);
  console.log(`${label}: ja4=${net.ja4} peetprint=${net.peetprint_hash}`);
  return net;
}

const a = await capture('before-linkedin');
await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));
const b = await capture('after-linkedin');

console.log('drift:', { ja4: a.ja4 !== b.ja4, peetprint: a.peetprint_hash !== b.peetprint_hash });
await ctx.close();
