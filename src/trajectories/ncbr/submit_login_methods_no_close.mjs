import { chromium } from 'playwright';
import { humanFill } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_BROWSER_ENDPOINT || 'http://127.0.0.1:9223';
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'Missing credentials env vars' }, null, 2));
  process.exit(2);
}

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] || await browser.newContext();
const page = context.pages()[0] || await context.newPage();

const events = [];
page.on('request', (req) => {
  const method = req.method();
  const url = req.url();
  if (!(url.includes('lsi2.ncbr.gov.pl') && (method !== 'GET' || url.includes('/user/refresh')))) return;
  let postData = req.postData() || '';
  postData = postData.replaceAll(password, '[REDACTED]').replaceAll(email, '[EMAIL]');
  events.push({ kind: 'request', method, url, postData: postData.slice(0, 1200) });
});
page.on('response', async (res) => {
  const method = res.request().method();
  const url = res.url();
  if (!(url.includes('lsi2.ncbr.gov.pl') && (method !== 'GET' || url.includes('/user/refresh')))) return;
  let text = '';
  try { text = await res.text(); } catch {}
  text = text.replaceAll(password, '[REDACTED]').replaceAll(email, '[EMAIL]');
  events.push({ kind: 'response', method, url, status: res.status(), text: text.slice(0, 1200) });
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

async function fillForm() {
  await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#mail', { timeout: 30000 });
  await humanFill(page, page.locator('#mail'), '');
  await page.locator('#mail').type(email, { delay: 15 });
  await humanFill(page, page.locator('#password'), '');
  await page.locator('#password').type(password, { delay: 15 });
  const checkbox = page.locator('#isStatuteAccepted').first();
  if (!(await checkbox.isChecked().catch(() => false))) {
    await humanClickLocator(page, page.locator('label:has(#isStatuteAccepted)')).catch(async () => {
      await humanClickLocator(page, checkbox);
    });
  }
  await page.waitForTimeout(500);
}

async function tryMethod(name, fn) {
  const start = events.length;
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = String(e?.message || e);
  }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(1500);
  const auth = await authStatus();
  return {
    name,
    error,
    url: page.url(),
    title: await page.title().catch(() => ''),
    auth,
    newEvents: events.slice(start),
  };
}

await fillForm();
const methods = [];

methods.push(await tryMethod('locator-click', async () => {
  await humanClickLocator(page, page.locator('#login-btn'));
}));
if (methods.at(-1).auth.status === 200) {
  console.log(JSON.stringify({ methods, events }, null, 2));
  process.exit(0);
}

methods.push(await tryMethod('keyboard-enter-password', async () => {
  await page.locator('#password').press('Enter');
}));
if (methods.at(-1).auth.status === 200) {
  console.log(JSON.stringify({ methods, events }, null, 2));
  process.exit(0);
}

methods.push(await tryMethod('dispatch-submit', async () => {
  await page.evaluate(() => {
    const form = document.querySelector('#mail')?.closest('form');
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}));
if (methods.at(-1).auth.status === 200) {
  console.log(JSON.stringify({ methods, events }, null, 2));
  process.exit(0);
}

methods.push(await tryMethod('request-submit', async () => {
  await page.evaluate(() => {
    const form = document.querySelector('#mail')?.closest('form');
    if (form?.requestSubmit) form.requestSubmit();
  });
}));

const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1600);
console.log(JSON.stringify({ methods, events, bodyText }, null, 2));
process.exit(0);
