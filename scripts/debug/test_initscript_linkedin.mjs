import { AsyncNewBrowser } from '../../dist/async_api.js';

const chromiumPath = process.env.CHROMIUM_PATH || '/Users/lukaszbartoszcze/.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium';
const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false, chromiumPath, pageDiagnostics: false });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));
const checks = await page.evaluate(() => ({
  hasWeles: typeof __weles !== 'undefined',
  hasWelesDefine: typeof window.__welesDefine === 'function',
  hasWelesNativeString: typeof window.__welesNativeString === 'function',
  screenIsProxy: false,
  screenDescriptor: (() => {
    const d = Object.getOwnPropertyDescriptor(window, 'screen') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'screen');
    return d ? { configurable: d.configurable, enumerable: d.enumerable, getNative: d.get ? d.get.toString().includes('native') : false } : null;
  })(),
  availTopDescriptor: (() => {
    const d = Object.getOwnPropertyDescriptor(screen, 'availTop') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(screen), 'availTop');
    return d ? { configurable: d.configurable, enumerable: d.enumerable, getNative: d.get ? d.get.toString().includes('native') : false } : null;
  })(),
  screenAvailTop: screen.availTop,
  rtcpString: String(window.RTCPeerConnection).slice(0, 80),
}));
console.log(JSON.stringify(checks, null, 2));
await ctx.close();
