// Create a fresh draft in STEP Ścieżka B (FENG.05.01-IP.01-003/26) through LSI UI.
// DIAG=1 only lists matching call cards/buttons. Never submits or withdraws.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const CALL = 'FENG.05.01-IP.01-003/26';
const LIST_URL = 'https://lsi2.ncbr.gov.pl/konkursy/w-trakcie-naboru';

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) { console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2)); process.exit(1); }


const responses = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!/project|contest|round|konkurs|wniosek/i.test(url)) return;
  let text = '';
  try { text = await res.text(); } catch {}
  responses.push({ status: res.status(), url, text: text });
});

await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (banner) banner.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralize cookie banner only

async function snapshot() {
  return await page.evaluate((call) => {
    const body = document.body.innerText || '';
    const candidates = [];
    const nodes = Array.from(document.querySelectorAll('a, article, section, div, li')).filter((e) => (e.innerText || '').includes(call));
    for (const n of nodes.slice(0, 20)) {
      const box = n.getBoundingClientRect();
      const buttons = Array.from(n.querySelectorAll('button, a')).map((b) => ({
        text: (b.innerText || b.getAttribute('aria-label') || b.title || '').trim(),
        href: b.href || null,
        disabled: Boolean(b.disabled),
      })).filter((b) => b.text || b.href).slice(0, 20);
      candidates.push({
        tag: n.tagName,
        text: (n.innerText || '').trim().slice(0, 1200),
        href: n.href || null,
        visible: box.width > 0 && box.height > 0,
        buttons,
      });
    }
    return {
      url: location.href,
      title: document.title,
      bodyHead: body,
      candidates,
      visibleButtons: Array.from(document.querySelectorAll('button, a')).map((b) => ({
        text: (b.innerText || b.getAttribute('aria-label') || b.title || '').trim(),
        href: b.href || null,
        disabled: Boolean(b.disabled),
        visible: Boolean(b.getClientRects().length) && getComputedStyle(b).visibility !== 'hidden',
      })).filter((b) => (b.text || b.href) && b.visible),
    };
  }, CALL); // allow-raw-playwright: read call list DOM
}

if (process.env.DIAG) {
  console.log(JSON.stringify(await snapshot(), null, 2));
  process.exit(0);
}

async function clickCall() {
  const callLink = page.locator('a').filter({ hasText: CALL }).filter({ visible: true }).first();
  const clicked = await callLink.count() > 0;
  if (clicked) await humanClickLocator(page, callLink);
  if (!clicked) throw new Error(`call link not found: ${CALL}`);
  await humanIdlePause('long');
  await page.waitForLoadState('load');
  await humanIdlePause('short');
}

async function clickApplyLikeButton() {
  const target = page.getByRole('button', { name: /Aplikuj|Rozpocznij|Utwórz|Złóż wniosek o dofinansowanie/i }).or(page.getByRole('link', { name: /Aplikuj|Rozpocznij|Utwórz|Złóż wniosek o dofinansowanie/i })).filter({ visible: true }).first();
  const clicked = await target.count() > 0;
  if (clicked) await humanClickLocator(page, target);
  if (!clicked) throw new Error('apply/start button not found');
  await humanIdlePause('long');
  await page.waitForLoadState('load');
  await humanIdlePause('long');
}

await clickCall();
const afterCall = await snapshot();
await clickApplyLikeButton();

// Some LSI flows show additional variant/confirmation modals before creating a
// draft; each one shown is confirmed until the draft page opens or none is left.
let extraClicks = [];
for (;;) {
  const target = page.getByRole('button', { name: /Utwórz projekt|Rozpocznij|Aplikuj|Dalej|Potwierdzam/i }).or(page.getByRole('link', { name: /Utwórz projekt|Rozpocznij|Aplikuj|Dalej|Potwierdzam/i })).filter({ visible: true }).first();
  const clicked = await target.textContent().catch(() => '');
  if (clicked) await humanClickLocator(page, target);
  if (!clicked) break;
  extraClicks.push(clicked);
  await humanIdlePause('long');
  await page.waitForLoadState('load');
  await humanIdlePause('short');
  if (/\/projekt\/[^/]+/.test(page.url())) break;
}

const final = await snapshot();
const projectMatch = page.url().match(/\/projekt\/([0-9a-f-]{36})/i);
console.log(JSON.stringify({
  afterCallUrl: afterCall.url,
  extraClicks,
  finalUrl: page.url(),
  projectId: projectMatch?.[1] || null,
  responses,
  final,
}, null, 2));
process.exit(0);
