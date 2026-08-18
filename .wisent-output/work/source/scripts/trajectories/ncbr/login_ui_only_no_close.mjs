// UI-only NCBR LSI login. No API/fetch auth probes. Never closes the page.

import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'Missing NCBR_EMAIL or NCBR_PASSWORD' }, null, 2));
  process.exit(2);
}

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] || await browser.newContext();
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(30000);

await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: public LSI login page navigation
await humanIdlePause('long');
const emailInput = page.locator('#mail, input[name="mail"]').first();
await emailInput.click(); // allow-raw-playwright: focus public LSI login input
await emailInput.press('Control+a'); // allow-raw-playwright: clear existing value
await emailInput.pressSequentially(email, { delay: 15 }); // allow-raw-playwright: trigger React input events
const passwordInput = page.locator('#password, input[name="password"]').first();
await passwordInput.click(); // allow-raw-playwright: focus public LSI login input
await passwordInput.press('Control+a'); // allow-raw-playwright: clear existing value
await passwordInput.pressSequentially(password, { delay: 15 }); // allow-raw-playwright: trigger React input events

const checkbox = page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first();
if (await checkbox.count()) {
  const checked = await checkbox.isChecked().catch(() => false);
  if (!checked) await checkbox.check({ force: true }); // allow-raw-playwright: accept LSI statute checkbox
}

const button = page.locator('#login-btn, button:has-text("Zaloguj")').first();
await button.waitFor({ state: 'visible' });
await humanIdlePause('deliberate');
const beforeClick = await button.evaluate((b) => ({ disabled: b.disabled, text: b.innerText.trim() })).catch((e) => ({ error: String(e?.message || e) }));
await button.click({ force: true }); // allow-raw-playwright: submit visible login form
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
await humanIdlePause('long');

console.log(JSON.stringify({
  beforeClick,
  url: page.url(),
  title: await page.title().catch(() => ''),
  body: (await page.locator('body').innerText().catch(() => '')).slice(0, 1000),
}, null, 2));
process.exit(0);
