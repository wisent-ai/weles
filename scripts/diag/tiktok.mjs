// Thin TikTok wrapper over the shared diagnosis harness. Restores the original
// TikTok-only REPL set (dob, email, pwd, code, click-send, click-next).

import { runDiag } from './session.mjs';

await runDiag({
  label: 'tiktok',
  startUrl: 'https://www.tiktok.com/signup/phone-or-email/email',
  filter: /tiktok\.com|tiktokv\.us|tiktokcdn|byteoversea|mssdk\./,
  replCommands: {
    dob: async ({ page, rest }) => {
      const [m, d, y] = rest;
      for (const [label, val] of [['month', m], ['day', d], ['year', y]]) {
        await page.locator(`[role="combobox"][aria-label*="${label}" i]`).first().click();
        await page.waitForTimeout(400);
        await page.locator(`[role="option"]`).filter({ hasText: new RegExp(`^${val}$`, 'i') }).first().click();
        await page.waitForTimeout(400);
      }
      console.log(`[repl] selected dob=${m}/${d}/${y}`);
    },
    email: async ({ page, arg }) => { await page.fill('input[type="email"], input[placeholder*="email" i]', arg); console.log(`[repl] filled email=${arg}`); },
    pwd: async ({ page, arg }) => { await page.fill('input[type="password"]', arg); console.log(`[repl] filled password (${arg.length} chars)`); },
    code: async ({ page, arg }) => { await page.fill('input[placeholder*="digit" i], input[name="code"]', arg); console.log(`[repl] filled code=${arg}`); },
    'click-send': async ({ page }) => { await page.locator('[data-e2e="send-code-button"]').first().click(); console.log(`[repl] clicked send-code`); },
    'click-next': async ({ page }) => { await page.locator('button:has-text("Next")').first().click(); console.log(`[repl] clicked Next`); },
  },
});
