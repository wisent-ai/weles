// LinkedIn login test with reCAPTCHA solver
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
  await page.locator('input#username, input#session_key, input[name="session_key"]').first().fill(process.env.LI_EMAIL || '');
  await page.locator('input#password, input#session_password, input[name="session_password"]').first().fill(process.env.LI_PASS || '');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(5000);
  console.log('URL after login:', page.url());
  if (page.url().includes('checkpoint') || page.url().includes('challenge')) {
    console.log('Checkpoint detected, solving reCAPTCHA...');
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
