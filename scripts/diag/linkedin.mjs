// Thin LinkedIn wrapper over the shared diagnosis harness. Captures the
// property-trap fingerprint signal that triggers LinkedIn's PerimeterX
// checkpointV2 challenge. Run with LAUNCH=weles and LAUNCH=chrome on the
// same login page; diff the two recordings/<label>_<mode>_<ts>.json files.
// Same pattern that uncovered the GitHub audio-codec fix and TikTok HEVC shim.
import { runDiag } from './session.mjs';

await runDiag({
  label: 'linkedin',
  startUrl: 'https://www.linkedin.com/login',
  filter: /linkedin\.com|licdn\.com|perimeterx\.net|px-cdn\.net|px-cloud\.net/,
  replCommands: {
    email: async ({ page, arg }) => { await page.fill('input[name="session_key"], #username', arg); console.log(`[repl] filled email=${arg}`); },
    pwd: async ({ page, arg }) => { await page.fill('input[name="session_password"], #password', arg); console.log(`[repl] filled password (${arg.length} chars)`); },
    submit: async ({ page }) => { await page.locator('button[type="submit"][aria-label*="Sign in" i], button:has-text("Sign in")').first().click(); console.log(`[repl] clicked Sign in`); },
    code: async ({ page, arg }) => { await page.fill('input[name="pin"], input[autocomplete="one-time-code"], input[name*="code" i]', arg); console.log(`[repl] filled verify code=${arg}`); },
    'submit-code': async ({ page }) => { await page.locator('button[type="submit"]').first().click(); console.log(`[repl] clicked verify Submit`); },
  },
});
