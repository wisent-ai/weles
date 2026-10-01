// Tencent Cloud AI3D (Hunyuan 3D) one-shot activation trajectory.
// Loads the cookie jar persisted by tencent/login.mjs, opens a weles Chromium
// already authenticated, and drives the Activate / Apply / Claim Free Credits
// click on the AI3D product page. If no jar exists, it waits for the operator
// to log in interactively in the opened window.

import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled, urlMatching } from '../_shared/page/settled.mjs';
import { loadTencentCookies } from './login.mjs';

const PRODUCT_URL = 'https://www.tencentcloud.com/products/ai3d';
// Console URL must match the cookie domain (.tencentcloud.com), not
// the .intl.cloud.tencent.com auth realm — login.mjs persists the jar
// scoped to *.tencentcloud.com and that's the only place the SSO
// session is valid.
const CONSOLE_URL = 'https://console.tencentcloud.com/hy3d';
// A console page that is not a login/sign-in page.
const ON_CONSOLE = /^https:\/\/console\.(intl\.)?(cloud\.tencent|tencentcloud)\.com\/(?!.*(\/login(\?|\/|$)|signin|signup))/i;

// Clicks the first visible match on the settled page; null when none shows.
async function clickFirstMatch(page, selectors) {
  await pageSettled(page);
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() > 0 && await loc.isVisible()) {
      console.log(`[activate] clicking selector: ${sel}`);
      await humanClickLocator(page, loc);
      return sel;
    }
  }
  return null;
}

async function main() {
  const s = await WSession.start({ label: 'tencent_activate_hunyuan3d', proxy: undefined });
  const page = s.page;

  try {
    const cookies = loadTencentCookies();
    await page.context().addCookies(cookies);
    console.log(`[activate] injected ${cookies.length} cookies from ~/.weles/cookie-jars/tencent.json`);
  } catch (e) {
    console.log(`[activate] no jar — waiting for interactive login. (${e.message})`);
  }

  console.log(`[activate] navigating to ${PRODUCT_URL}`);
  await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded' });

  const productClicked = await clickFirstMatch(page, [
    'a:has-text("Claim 200 Credit")',
    'a:has-text("Free Trial")',
    'button:has-text("Claim 200 Credit")',
    'button:has-text("Free Trial")',
  ]);
  console.log(`[activate] product-page CTA: ${productClicked || 'none found'}`);

  await pageSettled(page);
  if (!/console\.(intl\.)?(cloud\.tencent|tencentcloud)\.com/.test(page.url())) {
    console.log(`[activate] navigating to ${CONSOLE_URL}`);
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' });
  }

  console.log('[activate] waiting for login (URL leaves /login* and lands on console)...');
  const consoleUrl = await urlMatching(page, ON_CONSOLE);
  console.log(`[activate] post-login URL: ${consoleUrl}`);

  const activated = await clickFirstMatch(page, [
    'button:has-text("Activate")',
    'button:has-text("Activate Now")',
    'button:has-text("Apply")',
    'button:has-text("Open")',
    'button:has-text("Agree and Activate")',
    'button:has-text("Claim Free Credits")',
    'button:has-text("Get Free Credits")',
    'button:has-text("Subscribe")',
    'a:has-text("Activate")',
    '.t-button:has-text("Activate")',
    '[data-testid*="activate"]',
  ]);
  console.log(`[activate] activation CTA: ${activated || 'none found'}`);

  const confirmed = await clickFirstMatch(page, [
    'button:has-text("Confirm")',
    'button:has-text("OK")',
    'button:has-text("Agree")',
    'button:has-text("I have read and agree")',
    'button:has-text("Submit")',
  ]);
  console.log(`[activate] confirm CTA: ${confirmed || 'none/not needed'}`);

  await pageSettled(page);
  console.log('[activate] flow complete');
  await s.close();
}

main().catch((e) => { console.error('[activate] fatal:', e); process.exit(1); });
