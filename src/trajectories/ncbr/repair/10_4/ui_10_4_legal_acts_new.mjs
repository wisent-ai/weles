// UI-only sync for section 10.4 legal-act collection in the replacement NCBR draft.
// Keeps the legal-act table aligned to the vetted markdown rows. Never submits or withdraws.

import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { target } from './ui_10_4_legal_acts_new/source.mjs';
import { legalActsTable } from './ui_10_4_legal_acts_new/table.mjs';
import { legalActForm } from './ui_10_4_legal_acts_new/form.mjs';
import { runModes } from './ui_10_4_legal_acts_new/modes.mjs';

const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const projectId = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const SECTION_URL = `https://lsi2.ncbr.gov.pl/projekt/${projectId}/projekt_step/4e260fae-c455-41ce-bba3-d0df2a8767fd`;
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE' }, null, 2));
  process.exit(1);
}
page.setDefaultTimeout(15000);

await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: authenticated LSI section navigation
await humanIdlePause('long');
await page.evaluate(() => {
  const banner = Array.from(document.querySelectorAll('div')).find((d) => (d.innerText || '').includes('pliki cookies'));
  if (banner) banner.style.pointerEvents = 'none';
}); // allow-raw-playwright: neutralise cookie overlay only

const table = legalActsTable({ page });
const form = legalActForm({ page });
const { tableState, openOutdatedRow } = table;
const { diagForm, fillTextLikeField, setActTypeIfPresent } = form;
await runModes({ page, SECTION_URL, table, form });

const opened = await openOutdatedRow();
if (process.env.DIAG) {
  await diagForm(opened);
  process.exit(0);
}

const actType = await setActTypeIfPresent();
const justFill = await fillTextLikeField((el) => {
  const name = el.name || '';
  return name === 'uzasadnienie' || name.endsWith('.uzasadnienie');
}, target.formJustification);

await humanIdlePause('deliberate');
await humanIdlePause('deliberate');
let saveResult = 'saved';
try {
  const buttons = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const count = await buttons.count();
  if (!count) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, buttons.nth(count - 1));
  await humanIdlePause('long');
} catch (error) {
  saveResult = `NOT SAVED: ${String(error?.message || error).slice(0, 140)}`;
}

const readback = await tableState();
const allText = JSON.stringify(readback);
console.log(JSON.stringify({
  target,
  actType,
  justFill,
  saveResult,
  readback,
  staleHits: {
    industrialDirective: /2010\/75/.test(allText),
    bat: /\bBAT\b|najlepsz/i.test(allText),
    industrialEmissions: /emisji przemys/i.test(allText),
  },
}, null, 2));
process.exit(saveResult === 'saved' ? 0 : 2);
