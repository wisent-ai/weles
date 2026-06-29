import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/Users/lukaszbartoszcze/.local/share/weles-chromium/147.0.7727.108-weles.1/Chromium.app/Contents/MacOS/Chromium',
  headless: false,
  args: ['--window-position=0,0'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await ctx.addInitScript(`const __weles = { screen: { availTop: 33 } }; window.__welesCheck = typeof __weles !== 'undefined';`);
await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));
const res = await page.evaluate(() => ({
  hasWeles: typeof __weles !== 'undefined',
  welesCheck: window.__welesCheck,
  availTop: screen.availTop,
}));
console.log(JSON.stringify(res, null, 2));
await browser.close();
