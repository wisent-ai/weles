// Log in to NCBR LSI in the already-open browser page.
// Reads credentials from NCBR_EMAIL and NCBR_PASSWORD.
// Does not close the attached browser/page.

import { chromium } from 'playwright';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { pageSettled } from '../../_shared/page/settled.mjs';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const authUrl = (await import('#ncbr-settings')).projectPermissionsUrl();
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(
    JSON.stringify({ error: 'Missing NCBR_EMAIL or NCBR_PASSWORD' }, null, 2),
  );
  process.exit(2);
}

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] || (await browser.newContext());
let page = context.pages()[0] || (await context.newPage());

async function authStatus() {
  return await page.evaluate(async (authUrl) => {
    try {
      const res = await fetch(authUrl, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const text = await res.text();
      return { url: authUrl, status: res.status, text };
    } catch (error) {
      return { url: authUrl, error: String(error?.message || error) };
    }
  }, authUrl);
}

await page.goto('https://lsi2.ncbr.gov.pl/logowanie', {
  waitUntil: 'domcontentloaded',
});
await page.waitForSelector('input[name="mail"], #mail');
await humanFill(page, page.locator('input[name="mail"], #mail').first(), email);
await humanFill(
  page,
  page.locator('input[name="password"], #password').first(),
  password,
);

const checkbox = page
  .locator('input[name="isStatuteAccepted"], #isStatuteAccepted')
  .first();
if (await checkbox.count()) {
  const checked = await checkbox.isChecked().catch(() => false);
  if (!checked) await checkbox.check({ force: true });
}

const beforeUrl = page.url();
await Promise.all([
  page.waitForLoadState('load'),
  humanClickLocator(page, page.getByRole('button', { name: /zaloguj/i })),
]);

await pageSettled(page);
const auth = await authStatus();

console.log(
  JSON.stringify(
    {
      beforeUrl,
      afterUrl: page.url(),
      title: await page.title().catch(() => ''),
      auth,
      bodyText: await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    },
    null,
    2,
  ),
);

process.exit(0);
