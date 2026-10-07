// UI-only cleanup of literal Markdown artifacts in the replacement NCBR draft.
// Never submits the application.

import { chromium } from 'playwright';
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const projectId = (await import('#ncbr-settings')).projectId();
const base = [
  'https://',
  `lsi2.ncbr.gov.pl/projekt/${projectId}/projekt_step/`,
].join('');

const targets = [
  {
    section: '3.5',
    url: (await import('#ncbr-settings')).sectionUrl('3_5'),
    suffix: 'wykazanie_braku_barier',
  },
  {
    section: '10.4',
    url: (await import('#ncbr-settings')).sectionUrl('10_4'),
    suffix: 'opis_zasady_szesc_r',
  },
  {
    section: '10.2',
    url: (await import('#ncbr-settings')).sectionUrl('10_2'),
    suffix: 'zgodnosc_z_karta_praw_podstawowych',
  },
  {
    section: '10.3',
    url: (await import('#ncbr-settings')).sectionUrl('10_3'),
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
    'Suwerenność cyfrowa. Wisent RNM wzmacnia suwerenność cyfrową UE przez audytowalne modele językowe zgodne z AI Act i ogranicza zależność od dostawców spoza UE. W stosunku do pozostałych artykułów KPP projekt jest neutralny i nie narusza praw ani wolności w nich wskazanych.',
  );
}

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}

const results = [];
for (const target of targets) {
  await page.goto(target.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: navigate to existing LSI draft section only
  await humanIdlePause('long');
  const loc = page.locator(`textarea[name$="${target.suffix}"]`).first();
  if ((await loc.count()) === 0) {
    results.push({
      section: target.section,
      suffix: target.suffix,
      error: 'textarea not found',
    });
    continue;
  }
  const before = await loc.inputValue(); // allow-raw-playwright: read existing textarea value
  let after = repairTail(target.section, plain(before));
  const max = Number(await loc.getAttribute('maxlength')) || after.length;
  if (after.length > max) {
    throw new Error(
      `${target.section} cleanup too long: ${after.length}/${max}`,
    );
  }
  if (before !== after) {
    await humanFill(page, loc, after); // allow-raw-playwright: replace Markdown syntax with plain text in LSI textarea
    await humanIdlePause('deliberate');
    await humanClickLocator(
      page,
      page
        .locator('button:visible')
        .filter({ hasText: /^Zapisz$/ })
        .filter({ hasNot: page.locator('[disabled]') })
        .last(),
    ); // allow-raw-playwright: save changed section through visible UI
    await humanIdlePause('long');
  }
  await page.goto(target.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: readback after save
  await humanIdlePause('long');
  const read = await page
    .locator(`textarea[name$="${target.suffix}"]`)
    .first()
    .inputValue(); // allow-raw-playwright: readback value
  results.push({
    section: target.section,
    suffix: target.suffix,
    changed: before !== after,
    beforeLen: before.length,
    afterLen: after.length,
    hasMarkdown: /\*\*|^#{1,6}\s|<!--|\|---/m.test(read),
    text: read,
    len: read.length,
  });
}

console.log(JSON.stringify({ results }, null, 2));
process.exit(results.some((r) => r.error || r.hasMarkdown) ? 2 : 0);
