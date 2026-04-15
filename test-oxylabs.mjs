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
  // Fill login — try multiple approaches until one works
  for (let loginAttempt = 0; loginAttempt < 3; loginAttempt++) {
    // Try 1: Playwright fill with known selectors
    try { await page.fill('input#username', process.env.LI_EMAIL || '', {strict: false}); await page.fill('input#password', process.env.LI_PASS || '', {strict: false}); break; } catch {}
    try { await page.fill('input#session_key', process.env.LI_EMAIL || '', {strict: false}); await page.fill('input#session_password', process.env.LI_PASS || '', {strict: false}); break; } catch {}
    // Try 2: React setter via evaluate
    const filled = await page.evaluate(`(() => {
      const inputs = Array.from(document.querySelectorAll('input')).filter(e => e.type !== 'hidden' && e.type !== 'checkbox' && e.getBoundingClientRect().width > 100);
      if (inputs.length < 2) return false;
      const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if(s) s.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
      set(inputs[0], '${process.env.LI_EMAIL}'); set(inputs[1], '${process.env.LI_PASS}'); return true;
    })()`);
    if (filled) break;
    await page.waitForTimeout(2000);
  }
  await page.locator('button[type="submit"]').first().click().catch(() => page.keyboard.press('Enter'));
  await page.waitForTimeout(5000);
  console.log('URL after login:', page.url());
  if (page.url().includes('checkpoint') || page.url().includes('challenge')) {
    console.log('Checkpoint detected, solving reCAPTCHA with CapSolver API...');
    const solved = await solveRecaptchaV2(page);
    console.log('Captcha result:', solved);
    if (solved) {
      // After captcha solved, page may have already navigated. Try clicking submit if still on checkpoint.
      try {
        if (page.url().includes('checkpoint')) {
          await page.locator('button[type="submit"]').first().click();
        }
      } catch {}
      try { await page.waitForLoadState('domcontentloaded'); } catch {}
    }
  }
  try {
    console.log('Final URL:', page.url());
    writeFileSync('recordings/linkedin_test.png', await page.screenshot());
  } catch { console.log('Could not capture final screenshot (page may have navigated)'); }
} catch (e) {
  console.log('ERROR:', e.message.slice(0, 300));
} finally {
  await ctx.close().catch(() => {});
}
