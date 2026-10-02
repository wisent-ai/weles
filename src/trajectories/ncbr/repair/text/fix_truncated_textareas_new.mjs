// UI-only repair of two visibly truncated textarea endings in replacement NCBR draft.
// Never submits the application.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const projectId = (await import('#ncbr-settings')).projectId();
const base = ['https://', `lsi2.ncbr.gov.pl/projekt/${projectId}/projekt_step/`].join('');

const repairs = [
  {
    section: '3.5',
    url: (await import('#ncbr-settings')).sectionUrl('3_5'),
    suffix: 'wykazanie_braku_barier',
    repair(value) {
      return value.replace(/\s+Brak\s*$/, '').trim();
    },
  },
  {
    section: '10.4',
    url: (await import('#ncbr-settings')).sectionUrl('10_4'),
    suffix: 'opis_zasady_szesc_r',
    repair(value) {
      return value.replace(/Działania te są zgodne z AI\s*$/, 'Działania te są zgodne z AI Act.').trim();
    },
  },
];

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}


async function saveVisible() {
  await humanIdlePause('deliberate');
  const save = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true }).last();
  await humanClickLocator(page, save);
  await humanIdlePause('long');
}

const results = [];
for (const r of repairs) {
  await page.goto(r.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: navigate to existing LSI draft section only
  await humanIdlePause('long');
  const loc = page.locator(`textarea[name$="${r.suffix}"]`).first();
  if (await loc.count() === 0) {
    results.push({ section: r.section, suffix: r.suffix, error: 'textarea not found' });
    continue;
  }
  const before = await loc.inputValue(); // allow-raw-playwright: read current value
  const after = r.repair(before);
  const max = Number(await loc.getAttribute('maxlength')) || after.length;
  if (after.length > max) throw new Error(`${r.section} repair too long: ${after.length}/${max}`);
  if (after !== before) {
    await humanFill(page, loc, after); // allow-raw-playwright: repair truncated ending only
    await saveVisible();
  }
  await page.goto(r.url, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: readback after save
  await humanIdlePause('long');
  const read = await page.locator(`textarea[name$="${r.suffix}"]`).first().inputValue(); // allow-raw-playwright: readback value
  results.push({
    section: r.section,
    suffix: r.suffix,
    changed: before !== after,
    beforeLen: before.length,
    afterLen: after.length,
    suffixText: read.slice(-260),
  });
}

console.log(JSON.stringify({ results }, null, 2));
process.exit(results.some((r) => r.error) ? 2 : 0);
