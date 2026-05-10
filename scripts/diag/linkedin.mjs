// Thin LinkedIn wrapper over the shared diagnosis harness. Captures the
// property-trap fingerprint signal that triggers LinkedIn's PerimeterX
// checkpointV2 challenge. Run with LAUNCH=weles and LAUNCH=chrome on the
// same login page; diff the two recordings/<label>_<mode>_<ts>.json files.
// Same pattern that uncovered the GitHub audio-codec fix and TikTok HEVC shim.
import { runDiag } from './session.mjs';
import { humanFill } from '../../dist/human/keyboard.js';
import { humanClickLocator } from '../../dist/human/mouse.js';

await runDiag({
  label: 'linkedin',
  startUrl: 'https://www.linkedin.com/login',
  filter: /linkedin\.com|licdn\.com|perimeterx\.net|px-cdn\.net|px-cloud\.net/,
  replCommands: {
    email: async ({ page, arg }) => { await humanFill(page, page.locator('input[name="session_key"], #username').first(), arg); console.log(`[repl] filled email=${arg}`); },
    pwd: async ({ page, arg }) => { await humanFill(page, page.locator('input[name="session_password"], #password').first(), arg); console.log(`[repl] filled password (${arg.length} chars)`); },
    submit: async ({ page }) => { await humanClickLocator(page, page.locator('button[type="submit"][aria-label*="Sign in" i], button:has-text("Sign in")').first()); console.log(`[repl] clicked Sign in`); },
    code: async ({ page, arg }) => { await humanFill(page, page.locator('input[name="pin"], input[autocomplete="one-time-code"], input[name*="code" i]').first(), arg); console.log(`[repl] filled verify code=${arg}`); },
    'submit-code': async ({ page }) => { await humanClickLocator(page, page.locator('button[type="submit"]').first()); console.log(`[repl] clicked verify Submit`); },
  },
});
