// Log in to NCBR LSI in the already-open browser page.
// Reads credentials from NCBR_EMAIL and NCBR_PASSWORD.
// Does not close the attached browser/page.

import { chromium } from 'playwright';

const endpoint = process.env.NCBR_BROWSER_ENDPOINT || 'http://127.0.0.1:9223';
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'Missing NCBR_EMAIL or NCBR_PASSWORD' }, null, 2));
  process.exit(2);
}

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] || await browser.newContext();
let page = context.pages()[0] || await context.newPage();

async function authStatus() {
  return await page.evaluate(async () => {
    try {
      const res = await fetch(
        'https://lsi2.ncbr.gov.pl/api/beneficiary/project/433468ab-ff8a-4bd2-9f03-7da65ba73e1f/get-user-permissions',
        { credentials: 'include', headers: { Accept: 'application/json' } },
      );
      const text = await res.text();
      return { status: res.status, text: text.slice(0, 300) };
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  });
}

await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForSelector('input[name="mail"], #mail', { timeout: 30000 });
await page.fill('input[name="mail"], #mail', email);
await page.fill('input[name="password"], #password', password);

const checkbox = page.locator('input[name="isStatuteAccepted"], #isStatuteAccepted').first();
if (await checkbox.count()) {
  const checked = await checkbox.isChecked().catch(() => false);
  if (!checked) await checkbox.check({ force: true });
}

const beforeUrl = page.url();
await Promise.all([
  page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null),
  page.getByRole('button', { name: /zaloguj/i }).click({ timeout: 30000 }),
]);

await page.waitForTimeout(2500);
const auth = await authStatus();

console.log(JSON.stringify({
  beforeUrl,
  afterUrl: page.url(),
  title: await page.title().catch(() => ''),
  auth,
  bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 1200),
}, null, 2));

process.exit(0);
