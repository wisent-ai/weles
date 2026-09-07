// Submit the existing NCBR login form and capture relevant network responses.
// Uses env vars NCBR_EMAIL and NCBR_PASSWORD. Does not close the attached page.

import { chromium } from 'playwright';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_BROWSER_ENDPOINT || 'http://127.0.0.1:9223';
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'Missing NCBR_EMAIL or NCBR_PASSWORD' }, null, 2));
  process.exit(2);
}

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] || await browser.newContext();
const page = context.pages()[0] || await context.newPage();

const events = [];
function isRelevant(url, method = '') {
  const u = url.toLowerCase();
  return (
    method !== 'GET' ||
    u.includes('/login') ||
    u.includes('/logowanie') ||
    u.includes('/token') ||
    u.includes('/refresh') ||
    u.includes('/permissions')
  ) && (
    u.includes('lsi2.ncbr.gov.pl') ||
    u.includes('/api/')
  );
}

page.on('request', (req) => {
  const method = req.method();
  if (!isRelevant(req.url(), method)) return;
  let postData = req.postData() || '';
  if (postData) postData = postData.replace(password, '[REDACTED]').replace(email, '[EMAIL]');
  events.push({ kind: 'request', method, url: req.url(), postData: postData.slice(0, 800) });
});

page.on('response', async (res) => {
  const req = res.request();
  if (!isRelevant(res.url(), req.method())) return;
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  if (text) text = text.replace(password, '[REDACTED]').replace(email, '[EMAIL]');
  events.push({
    kind: 'response',
    method: req.method(),
    url: res.url(),
    status: res.status(),
    text: text.slice(0, 1200),
  });
});

async function authStatus() {
  return await page.evaluate(async () => {
    try {
      const res = await fetch(
        'https://lsi2.ncbr.gov.pl/api/beneficiary/project/433468ab-ff8a-4bd2-9f03-7da65ba73e1f/get-user-permissions',
        { credentials: 'include', headers: { Accept: 'application/json' } },
      );
      return { status: res.status, text: (await res.text()).slice(0, 500) };
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  });
}

await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForSelector('#mail, input[name="mail"]', { timeout: 30000 });

await humanFill(page, page.locator('#mail, input[name="mail"]').first(), email);
await humanFill(page, page.locator('#password, input[name="password"]').first(), password);

const checkbox = page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first();
if (await checkbox.count()) {
  const checked = await checkbox.isChecked().catch(() => false);
  if (!checked) {
    const label = page.locator('label:has(#isStatuteAccepted), label:has(input[name="isStatuteAccepted"])').filter({ visible: true }).first();
    await humanClickLocator(page, await label.count() > 0 ? label : checkbox);
  }
}

const button = page.locator('#login-btn, button:has-text("Zaloguj się")').first();
await button.waitFor({ state: 'visible', timeout: 30000 });

const before = {
  url: page.url(),
  fields: await page.evaluate(() => Array.from(document.querySelectorAll('input')).map((el) => ({
    id: el.id,
    name: el.name,
    type: el.type,
    valueLength: el.value?.length || 0,
    checked: el.checked,
    disabled: el.disabled,
  }))),
  loginButtonDisabled: await button.evaluate((el) => el.disabled).catch(() => null),
};

await humanClickLocator(page, button);

await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(4000);

const auth = await authStatus();
const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1600);

console.log(JSON.stringify({
  before,
  afterUrl: page.url(),
  title: await page.title().catch(() => ''),
  auth,
  events,
  bodyText,
}, null, 2));

process.exit(0);
