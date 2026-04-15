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
  // Try multiple approaches to fill the login form
  try { await page.fill('input#username', process.env.LI_EMAIL || ''); await page.fill('input#password', process.env.LI_PASS || ''); }
  catch { try { await page.fill('input#session_key', process.env.LI_EMAIL || ''); await page.fill('input#session_password', process.env.LI_PASS || ''); }
  catch {
    // Coordinate-based: click first visible text input, type, tab, type
    const box = await page.evaluate(`(() => { for (const el of document.querySelectorAll('input')) { if (el.type==='hidden'||el.type==='checkbox') continue; const r=el.getBoundingClientRect(); if (r.width>100&&r.height>20) return {x:r.x+r.width/2,y:r.y+r.height/2}; } return null; })()`);
    if (box) { await page.mouse.click(box.x, box.y); await page.keyboard.type(process.env.LI_EMAIL||'',{delay:30}); await page.keyboard.press('Tab'); await page.keyboard.type(process.env.LI_PASS||'',{delay:30}); }
  }}
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
