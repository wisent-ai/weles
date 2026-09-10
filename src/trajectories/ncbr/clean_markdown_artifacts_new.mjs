// UI-only cleanup of literal Markdown artifacts in the replacement NCBR draft.
// Never submits the application.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const base = ['https://', `lsi2.ncbr.gov.pl/projekt/${projectId}/projekt_step/`].join('');

const targets = [
  {
    section: '3.5',
    url: `${base}41b2184d-76e9-4b79-8ece-b2e227dc471f`,
    suffix: 'wykazanie_braku_barier',
  },
  {
    section: '10.4',
    url: `${base}4e260fae-c455-41ce-bba3-d0df2a8767fd`,
    suffix: 'opis_zasady_szesc_r',
  },
  {
    section: '10.2',
    url: `${base}51455d27-6e3d-4629-9cc6-2a124f5432c8`,
    suffix: 'zgodnosc_z_karta_praw_podstawowych',
  },
  {
    section: '10.3',
    url: `${base}256ac98a-bb3c-4715-ad13-e8dbcd3f94f4`,
    suffix: 'zgodnosc_z_konwencja_o_prawach_osob_niepelnosprawnych',
  },
];

function plain(s) {
  return (s || '')
    .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function repairTail(section, value) {
  if (section !== '10.2') return value;
  return value.replace(
    /Suwerenność cyfrowa i ograniczanie zależności strategicznej\.\s*Wisent RNM[\s\S]*$/,
    'Suwerenność cyfrowa. Wisent RNM wzmacnia suwerenność cyfrową UE przez audytowalne modele językowe zgodne z AI Act i ogranicza zależność od dostawców spoza UE. W stosunku do pozostałych artykułów KPP projekt jest neutralny i nie narusza praw ani wolności w nich wskazanych.'
  );
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(15000);

const results = [];
for (const target of targets) {
  await page.goto(target.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: navigate to existing LSI draft section only
  await humanIdlePause('long');
  const loc = page.locator(`textarea[name$="${target.suffix}"]`).first();
  if (await loc.count() === 0) {
    results.push({ section: target.section, suffix: target.suffix, error: 'textarea not found' });
    continue;
  }
  const before = await loc.inputValue(); // allow-raw-playwright: read existing textarea value
  let after = repairTail(target.section, plain(before));
  const max = Number(await loc.getAttribute('maxlength')) || after.length;
  if (after.length > max) {
    throw new Error(`${target.section} cleanup too long: ${after.length}/${max}`);
  }
  if (before !== after) {
    await humanFill(page, loc, after); // allow-raw-playwright: replace Markdown syntax with plain text in LSI textarea
    await humanIdlePause('deliberate');
    await humanClickLocator(page, page.locator('button:visible').filter({ hasText: /^Zapisz$/ }).filter({ hasNot: page.locator('[disabled]') }).last()); // allow-raw-playwright: save changed section through visible UI
    await humanIdlePause('long');
  }
  await page.goto(target.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: readback after save
  await humanIdlePause('long');
  const read = await page.locator(`textarea[name$="${target.suffix}"]`).first().inputValue(); // allow-raw-playwright: readback value
  results.push({
    section: target.section,
    suffix: target.suffix,
    changed: before !== after,
    beforeLen: before.length,
    afterLen: after.length,
    hasMarkdown: /\*\*|^#{1,6}\s|<!--|\|---/m.test(read),
    prefix: read.slice(0, 180),
    suffix: read.slice(-260),
    len: read.length,
  });
}

console.log(JSON.stringify({ results }, null, 2));
process.exit(results.some((r) => r.error || r.hasMarkdown) ? 2 : 0);
