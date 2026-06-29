import { chromium } from 'playwright';

const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: exe, headless: false, args: ['--window-position=0,0'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto('about:blank');
const info = await page.evaluate(() => {
  const desc = Object.getOwnPropertyDescriptor(window, 'screen') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'screen');
  const scr = screen;
  const proto = Object.getPrototypeOf(scr);
  const topDesc = Object.getOwnPropertyDescriptor(scr, 'availTop') || Object.getOwnPropertyDescriptor(proto, 'availTop');
  return {
    screenAvailTop: scr.availTop,
    screenAvailLeft: scr.availLeft,
    screenWidth: scr.width,
    screenHeight: scr.height,
    windowScreenDescriptor: desc ? { configurable: desc.configurable, enumerable: desc.enumerable, getNative: !!desc.get } : null,
    availTopDescriptor: topDesc ? { configurable: topDesc.configurable, enumerable: topDesc.enumerable, getNative: !!topDesc.get } : null,
  };
});
console.log(JSON.stringify(info, null, 2));

// Try override
const overrideRes = await page.evaluate(() => {
  const scr = { availTop: 30, availLeft: 0, width: 1920, height: 1080 };
  const results = [];
  try {
    const proxy = new Proxy(screen, {
      get(target, prop) {
        if (prop === 'availTop' && scr.availTop !== undefined) return scr.availTop;
        return target[prop];
      }
    });
    Object.defineProperty(window, 'screen', { get: () => proxy, configurable: true, enumerable: true });
    results.push({ method: 'proxy_window_screen', success: true, after: screen.availTop });
  } catch (e) {
    results.push({ method: 'proxy_window_screen', success: false, error: e.message });
  }
  try {
    Object.defineProperty(screen, 'availTop', { value: 30, configurable: true });
    results.push({ method: 'define_screen_availTop', success: true, after: screen.availTop });
  } catch (e) {
    results.push({ method: 'define_screen_availTop', success: false, error: e.message });
  }
  try {
    Object.defineProperty(Screen.prototype, 'availTop', { get: () => 30, configurable: true });
    results.push({ method: 'define_Screen_proto', success: true, after: screen.availTop });
  } catch (e) {
    results.push({ method: 'define_Screen_proto', success: false, error: e.message });
  }
  try {
    Object.setPrototypeOf(screen, {});
    results.push({ method: 'setPrototypeOf_screen', success: true });
  } catch (e) {
    results.push({ method: 'setPrototypeOf_screen', success: false, error: e.message });
  }
  return results;
});
console.log(JSON.stringify(overrideRes, null, 2));
await browser.close();
