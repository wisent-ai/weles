// Section 7 risk collection for the replacement draft. Never submits.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { cellShowsSource } from '../../../../_shared/page/shows.mjs';
import { assertFits } from '../../../form-input.mjs';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const SECTION_URL = (await import('#ncbr-settings')).sectionUrl('7');
const MD = readFileSync(
  (await import('#ncbr-settings')).applicationFile('wersja_B_7_ryzyka.md'),
  'utf8',
);

function field(block, label) {
  const marker = `**${label}**`;
  const a = block.indexOf(marker);
  if (a < 0) return '';
  const rest = block.slice(a + marker.length).replace(/^\s+/, '');
  const b = rest.search(/\n\n\*\*|\n## /);
  return rest
    .slice(0, b >= 0 ? b : undefined)
    .replace(/\s+/g, ' ')
    .trim();
}
const risks = MD.split(/^## Ryzyka\s*$/m)
  .slice(1)
  .map((block) => ({
    nazwa: field(block, 'Nazwa ryzyka'),
    typ: field(block, 'Typ ryzyka'),
    opis: field(block, 'Opis ryzyka'),
    zapobieganie: field(block, 'Zapobieganie ryzyku'),
  }))
  .filter((r) => r.nazwa && r.typ && r.opis && r.zapobieganie);

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }));
  process.exit(1);
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('div')).find((d) =>
    (d.innerText || '').includes('pliki cookies'),
  );
  if (b) b.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie banner

async function clickDodaj() {
  await humanClickLocator(
    page,
    page
      .locator('button:visible')
      .filter({ hasText: /^Dodaj$/ })
      .first(),
  ); // allow-raw-playwright: open risk subform
  await humanIdlePause('long');
}

async function setAuto(name, search) {
  const inp = page
    .locator(`input[name="${name}"], input[name$="${name}"]`)
    .first();
  await humanClickLocator(page, inp); // allow-raw-playwright: open risk type autocomplete
  await humanFill(page, inp, search); // allow-raw-playwright: filter risk type
  await humanIdlePause('deliberate');
  const opt = page
    .locator("[role='listbox'] [role='option'], [role='option']")
    .first();
  if ((await opt.count()) === 0)
    throw new Error(`no option for ${name}: ${search}`);
  const picked = (await opt.textContent())?.trim();
  await opt.dispatchEvent('click'); // allow-raw-playwright: select risk type
  await humanIdlePause('short');
  return picked;
}

async function fillName(name, value) {
  const loc = page
    .locator(
      `textarea[name="${name}"], input[name="${name}"], textarea[name$="${name}"], input[name$="${name}"]`,
    )
    .first();
  await loc.waitFor({ state: 'visible' });
  let v = String(value || '');
  const max = await assertFits(loc, v);
  await humanFill(page, loc, v); // allow-raw-playwright: risk text field
  await humanIdlePause('short');
  return `${name} ${v.length}/${max}`;
}

async function saveEnabled() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await humanClickLocator(
    page,
    page
      .locator('button:visible:not([disabled])')
      .filter({ hasText: /^Zapisz$/ })
      .last(),
  ); // allow-raw-playwright: save risk subform
  await humanIdlePause('long');
}

if (process.env.DIAG) {
  await clickDodaj();
  const out = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea'))
      .map((el) => ({
        tag: el.tagName,
        name: el.name || null,
        role: el.getAttribute('role'),
        max: el.getAttribute('maxlength'),
      }))
      .filter((f) => f.name),
  );
  console.log(JSON.stringify({ parsed: risks.length, fields: out }, null, 2));
  process.exit(0);
}

const added = [];
for (const r of risks) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const exists = await page.evaluate(cellShowsSource, r.nazwa);
  if (exists) continue;
  await clickDodaj();
  const filled = [];
  filled.push(await fillName('nazwa_ryzyka', r.nazwa));
  const picked = await setAuto('typ_ryzyka', r.typ);
  filled.push(await fillName('opis_ryzyka', r.opis));
  filled.push(await fillName('zapobieganie', r.zapobieganie));
  await saveEnabled();
  added.push({ name: r.nazwa, picked, filled });
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
const readback = await page.evaluate(() => {
  const table = document.querySelector('table');
  return {
    rows: table ? table.querySelectorAll('tbody tr').length : 0,
    text: (table?.innerText || '').replace(/\s+/g, ' '),
  };
});
console.log(JSON.stringify({ parsed: risks.length, added, readback }, null, 2));
process.exit(0);
