// Thin GitHub wrapper over the shared diagnosis harness. REPL commands for
// bot-fills (email-h/pwd-h/user-h via humanClick+humanType over CDP), native
// OS events (email-n/pwd-n/user-n via cliclick with AppleScript Chromium
// activation), and click-create via Playwright locator click.

import { spawnSync } from 'node:child_process';
import { runDiag } from './session.mjs';

const WELES_DIST = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/dist';
const { humanClick, nativeType } = await import(`${WELES_DIST}/human/mouse.js`);
const { nextDwellMs, nextInterKeyMs } = await import(`${WELES_DIST}/human/trace.js`);

const waitMs = (ms) => new Promise(r => setTimeout(r, ms));  // allow-raw-playwright: utility sleep shim — usages should migrate to humanIdlePause

const humanFill = async ({ page, cdp }, sel, val) => {
  const bb = await page.locator(sel).first().boundingBox();
  if (!bb) throw new Error(`no bbox for ${sel}`);
  let cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  await humanClick(page, Math.round(cx), Math.round(cy));
  for (const char of val) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char, unmodifiedText: char });
    await waitMs(nextDwellMs());
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char, key: char, unmodifiedText: char });
    if (Math.random() < 0.3) { cx += (Math.random() * 2 - 1) * 4; cy += (Math.random() * 2 - 1) * 4; await page.mouse.move(Math.round(cx), Math.round(cy)); }
    await waitMs(nextInterKeyMs());
  }
};

const native = async (arg) => {
  spawnSync('osascript', ['-e', 'tell application "Chromium" to activate']);
  await waitMs(300);
  await nativeType(arg);
};

await runDiag({
  label: 'github',
  startUrl: 'https://github.com/signup',
  filter: /github\.com|arkoselabs\.com|octocaptcha\.com/,
  replCommands: {
    'email-h': async (ctx) => { await humanFill(ctx, '#email', ctx.arg); console.log(`[repl] gh email-h=${ctx.arg}`); },
    'pwd-h': async (ctx) => { await humanFill(ctx, '#password', ctx.arg); console.log(`[repl] gh pwd-h (${ctx.arg.length} chars)`); },
    'user-h': async (ctx) => { await humanFill(ctx, '#login', ctx.arg); console.log(`[repl] gh user-h=${ctx.arg}`); },
    'email-n': async ({ arg }) => { await native(arg); console.log(`[repl] gh email-n (native)=${arg}`); },
    'pwd-n': async ({ arg }) => { await native(arg); console.log(`[repl] gh pwd-n (native, ${arg.length} chars)`); },
    'user-n': async ({ arg }) => { await native(arg); console.log(`[repl] gh user-n (native)=${arg}`); },
    'click-create': async ({ page }) => { await page.locator('button.js-octocaptcha-load-captcha, button:has-text("Create account")').first().click(); console.log(`[repl] gh clicked Create`); },
  },
});
