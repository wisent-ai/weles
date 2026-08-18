// Thin TikTok wrapper over the shared diagnosis harness. Restores the original
// TikTok-only REPL set (dob, email, pwd, code, click-send, click-next).

import { runDiag } from './session.mjs';
import { humanIdlePause, humanClickLocator } from '../../dist/human/mouse.js';
import { humanFill } from '../../dist/human/keyboard.js';

await runDiag({
  label: 'tiktok',
  startUrl: 'https://www.tiktok.com/signup/phone-or-email/email',
  filter: /tiktok\.com|tiktokv\.us|tiktokcdn|byteoversea|mssdk\./,
  replCommands: {
    dob: async ({ page, rest }) => {
      const [m, d, y] = rest;
      for (const [label, val] of [['month', m], ['day', d], ['year', y]]) {
        await humanClickLocator(page, page.locator(`[role="combobox"][aria-label*="${label}" i]`).first());
        await humanIdlePause('short');
        await humanClickLocator(page, page.locator(`[role="option"]`).filter({ hasText: new RegExp(`^${val}$`, 'i') }).first());
        await humanIdlePause('short');
      }
      console.log(`[repl] selected dob=${m}/${d}/${y}`);
    },
    email: async ({ page, arg }) => { await humanFill(page, page.locator('input[type="email"], input[placeholder*="email" i]').first(), arg); console.log(`[repl] filled email=${arg}`); },
    pwd: async ({ page, arg }) => { await humanFill(page, page.locator('input[type="password"]').first(), arg); console.log(`[repl] filled password (${arg.length} chars)`); },
    code: async ({ page, arg }) => { await humanFill(page, page.locator('input[placeholder*="digit" i], input[name="code"]').first(), arg); console.log(`[repl] filled code=${arg}`); },
    'click-send': async ({ page }) => { await humanClickLocator(page, page.locator('[data-e2e="send-code-button"]').first()); console.log(`[repl] clicked send-code`); },
    'click-next': async ({ page }) => { await humanClickLocator(page, page.locator('button:has-text("Next")').first()); console.log(`[repl] clicked Next`); },
  },
});
