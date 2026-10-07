// Section 1.1 filler for fresh STEP B draft. UI-only, never submits.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { selectRadio } from '../../../form-input.mjs';

const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
const PROJECT_ID = (await import('#ncbr-settings')).projectId();
const SECTION_URL = (await import('#ncbr-settings')).sectionUrl('1_1');
const MD = (await import('#ncbr-settings')).applicationFile(
  'wersja_B_1_1_informacje_ogolne.md',
);
const NB = 'MODUL_DANE_PAKIETU.czesc_ogolna.informacje_ogolne_o_projekcie.';

const md = readFileSync(MD, 'utf8');
function afterHeader(header, nextHeader) {
  let part = md.split(header)[1];
  if (part === undefined) throw new Error(`missing header: ${header}`);
  if (nextHeader) part = part.split(nextHeader)[0];
  return part.replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
}

const title =
  'Duże modele językowe oparte na reprezentacjach jako nowa europejska architektura AI z wbudowaną audytowalnością, sterowaniem i zgodnością z AI Act';
let summary = afterHeader(
  '## Streszczenie projektu',
  '## Wniosek dotyczący projektu składany jest ponownie',
);
summary = summary.replace(/^\s*\([^)]*limit[^)]*\)\s*/i, '');
summary = summary.replace(/^\*\*Streszczenie projektu.*?\*\*\s*/s, '').trim();

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(`textarea[name="${NB}tytul_projektu"]`);
// The form states each field's limit in its maxlength; a text over it is
// refused by name instead of cut.
const limits = await page.evaluate(
  (nb) => ({
    title: document
      .querySelector(`textarea[name="${nb}tytul_projektu"]`)
      ?.getAttribute('maxlength'),
    summary: document
      .querySelector(`textarea[name="${nb}streszczenie_projektu"]`)
      ?.getAttribute('maxlength'),
  }),
  NB,
); // allow-raw-playwright: read the form's own field limits
for (const [field, text] of [
  ['title', title],
  ['summary', summary],
]) {
  if (limits[field] && text.length > Number(limits[field])) {
    throw new Error(
      `${field} is ${text.length} characters; the form's maxlength is ${limits[field]}`,
    );
  }
}

await selectRadio(
  page,
  page.locator('input[type="radio"][value="samodzielnie"]').first(),
);
await humanFill(
  page,
  page.locator(`textarea[name="${NB}tytul_projektu"]`).first(),
  title,
);
await humanFill(
  page,
  page
    .locator(`input[name="${NB}data_rozpoczecia_realizacji_projektu"]`)
    .first(),
  '01.09.2026',
);
await humanFill(
  page,
  page
    .locator(`input[name="${NB}data_zakonczenia_realizacji_projektu"]`)
    .first(),
  '31.08.2029',
);
await humanFill(
  page,
  page.locator(`textarea[name="${NB}streszczenie_projektu"]`).first(),
  summary,
);
await selectRadio(
  page,
  page.locator('input[type="radio"][value="Nie"]').last(),
);

let saveResult = 'saved';
try {
  const saves = page
    .getByRole('button', { name: 'Zapisz', exact: true })
    .filter({ visible: true });
  const count = await saves.count();
  if (!count) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.nth(count - 1));
  await humanIdlePause('long');
} catch (e) {
  saveResult = `NOT SAVED: ${String(e?.message || e)}`;
}

const readback = await page.evaluate(
  (nb) => ({
    titleLen:
      document.querySelector(`textarea[name="${nb}tytul_projektu"]`)?.value
        .length ?? null,
    summaryLen:
      document.querySelector(`textarea[name="${nb}streszczenie_projektu"]`)
        ?.value.length ?? null,
    start:
      document.querySelector(
        `input[name="${nb}data_rozpoczecia_realizacji_projektu"]`,
      )?.value ?? null,
    end:
      document.querySelector(
        `input[name="${nb}data_zakonczenia_realizacji_projektu"]`,
      )?.value ?? null,
    checked: Array.from(
      document.querySelectorAll(
        '.MuiRadio-root.Mui-checked input[type="radio"]',
      ),
    ).map((r) => r.value),
  }),
  NB,
); // allow-raw-playwright: read back 1.1 fields

console.log(JSON.stringify({ saveResult, readback }, null, 2));
process.exit(0);
