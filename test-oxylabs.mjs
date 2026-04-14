// LinkedIn login test with CapSolver API captcha solver
import { AsyncNewBrowser } from './dist/async_api.js';
import { solveRecaptchaV2 } from './dist/captcha/recaptcha.js';
import { writeFileSync } from 'node:fs';

const proxyOpt = process.env.PROXY_URL ? (() => {
  const u = new URL(process.env.PROXY_URL);
  return { server: `${u.protocol}//${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
})() : undefined;
const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false, proxy: proxyOpt });
const page = ctx.pages()[0] || await ctx.newPage();
try {
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  // Use evaluate + keyboard (Playwright fill() times out on LinkedIn's custom inputs)
  await page.evaluate(`document.querySelector('input[type="text"], input:not([type="hidden"])').focus()`);
  await page.keyboard.type(process.env.LI_EMAIL || '', { delay: 30 });
  await page.keyboard.press('Tab');
  await page.keyboard.type(process.env.LI_PASS || '', { delay: 30 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);
  console.log('URL after login:', page.url());
  if (page.url().includes('checkpoint') || page.url().includes('challenge')) {
    console.log('Checkpoint detected, solving reCAPTCHA with CapSolver API...');
    const solved = await solveRecaptchaV2(page);
    console.log('Captcha result:', solved);
    if (solved) {
      try { await page.locator('button[type="submit"]').first().click(); } catch {}
      await page.waitForTimeout(5000);
    }
  }
  console.log('Final URL:', page.url());
  writeFileSync('recordings/linkedin_test.png', await page.screenshot());
  open('recordings/linkedin_test.png');
} catch (e) {
  console.log('ERROR:', e.message.slice(0, 300));
} finally {
  await ctx.close().catch(() => {});
}
