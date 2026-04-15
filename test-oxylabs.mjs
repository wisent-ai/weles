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
    // Dump bframe image DOM before solving
    const bframe = page.frames().find(f => f.url()?.includes('/bframe'));
    if (bframe) {
      // Click checkbox first
      try {
        const ci = page.frameLocator('iframe[src*="captchaInternal"]');
        await ci.frameLocator('iframe[src*="anchor"]').first().locator('#recaptcha-anchor').click();
        await page.waitForEvent('frameattached').catch(() => {});
        await page.waitForTimeout(3000);
      } catch {}
      const bf2 = page.frames().find(f => f.url()?.includes('/bframe'));
      if (bf2) {
        const imgInfo = await bf2.evaluate(`(() => {
          const imgs = document.querySelectorAll('img');
          const result = [];
          for (const img of imgs) { result.push({ src: img.src?.slice(0,80), w: img.naturalWidth, h: img.naturalHeight, cls: img.className?.slice(0,40) }); }
          const tds = document.querySelectorAll('table td');
          return { imgCount: imgs.length, tdCount: tds.length, imgs: result.slice(0,20) };
        })()`).catch(() => null);
        console.log('BFRAME IMAGE DOM:', JSON.stringify(imgInfo, null, 2));
        // Save the image we're extracting
        const gridImgB64 = await bf2.evaluate(`(() => {
          const img = document.querySelector('.rc-image-tile-wrapper img, table.rc-imageselect-table img');
          if (!img) return null;
          const c = document.createElement('canvas'); c.width = img.naturalWidth||img.width; c.height = img.naturalHeight||img.height;
          c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png').split(',')[1];
        })()`).catch(() => null);
        if (gridImgB64) { writeFileSync('recordings/extracted_grid.png', Buffer.from(gridImgB64, 'base64')); console.log('Saved extracted grid image'); }
      }
    }
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
