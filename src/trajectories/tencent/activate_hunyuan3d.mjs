// Tencent Cloud AI3D (Hunyuan 3D) one-shot activation trajectory.
// Loads the cookie jar persisted by tencent/login.mjs, opens a weles Chromium
// already authenticated, and drives the Activate / Apply / Claim Free Credits
// click on the AI3D product page. If no jar exists, falls back to the
// interactive login wait so the trajectory still completes end-to-end.

import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { loadTencentCookies } from './login.mjs';

const PRODUCT_URL = 'https://www.tencentcloud.com/products/ai3d';
// Console URL must match the cookie domain (.tencentcloud.com), not
// the .intl.cloud.tencent.com auth realm — login.mjs persists the jar
// scoped to *.tencentcloud.com and that's the only place the SSO
// session is valid.
const CONSOLE_URL = 'https://console.tencentcloud.com/hy3d';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickFirstMatch(page, selectors, opts) {
  const deadline = Date.now() + (opts && opts.budgetMs);
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
        console.log(`[activate] clicking selector: ${sel}`);
        try { await humanClickLocator(page, loc); } catch { /* selector may have detached */ }
        return sel;
      }
    }
    await sleep(500);
  }
  return null;
}

async function waitForLogin(page) {
  console.log('[activate] waiting for login (URL leaves /login* and lands on console)...');
  let lastUrl = '';
  for (let i = 0; i < 900; i++) {
    const url = page.url();
    if (url !== lastUrl) {
      const cookies = await page.context().cookies();
      const tcCookies = cookies.filter((c) => /tencentcloud\.com$|tencent\.com$|qq\.com$/.test(c.domain));
      console.log(`[activate] poll ${i} url=${url} tc-cookies=${tcCookies.map((c) => c.name).join(',') || '(none)'}`);
      lastUrl = url;
    }
    const onConsole = /console\.(intl\.)?(cloud\.tencent|tencentcloud)\.com/.test(url);
    const onLogin = /\/login(\?|\/|$)|signin|signup|account\.tencentcloud\.com/i.test(url);
    if (onConsole && !onLogin) {
      console.log(`[activate] login detected via URL: ${url}`);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

async function main() {
  const s = await WSession.start({ label: 'tencent_activate_hunyuan3d', proxy: undefined });
  const page = s.page;

  let jarLoaded = false;
  try {
    const cookies = loadTencentCookies();
    await page.context().addCookies(cookies);
    console.log(`[activate] injected ${cookies.length} cookies from ~/.weles/cookie-jars/tencent.json`);
    jarLoaded = true;
  } catch (e) {
    console.log(`[activate] no jar — will wait for interactive login. (${e.message})`);
  }

  console.log(`[activate] navigating to ${PRODUCT_URL}`);
  await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('goto warn:', e.message));

  const productClicked = await clickFirstMatch(page, [
    'a:has-text("Claim 200 Credit")',
    'a:has-text("Free Trial")',
    'button:has-text("Claim 200 Credit")',
    'button:has-text("Free Trial")',
  ], { budgetMs: 8000 });
  console.log(`[activate] product-page CTA: ${productClicked || 'none found'}`);

  await sleep(2500);
  if (!/console\.(intl\.)?(cloud\.tencent|tencentcloud)\.com/.test(page.url())) {
    console.log(`[activate] navigating to ${CONSOLE_URL}`);
    await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('goto warn:', e.message));
  }

  const loggedIn = await waitForLogin(page);
  if (!loggedIn) { console.error('[activate] login timeout — exiting'); await s.close(); process.exit(1); }

  await sleep(3000);
  console.log(`[activate] post-login URL: ${page.url()}`);

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
  ], { budgetMs: 60000 });
  console.log(`[activate] activation CTA: ${activated || 'none found'}`);

  await sleep(2000);
  const confirmed = await clickFirstMatch(page, [
    'button:has-text("Confirm")',
    'button:has-text("OK")',
    'button:has-text("Agree")',
    'button:has-text("I have read and agree")',
    'button:has-text("Submit")',
  ], { budgetMs: 8000 });
  console.log(`[activate] confirm CTA: ${confirmed || 'none/not needed'}`);

  await sleep(8000);
  console.log('[activate] flow complete; closing session in 10s');
  await sleep(10000);
  await s.close();
}

main().catch((e) => { console.error('[activate] fatal:', e); process.exit(1); });
