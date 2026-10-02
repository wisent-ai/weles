// Targeted review-risk repair for the replacement NCBR STEP B draft.
// Edits only 6.1 task 5 and selected 9.2 indicator descriptions. Never submits.

import { WSession } from '../../../../../dist/index.js';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { validateProject } from '../../validation.mjs';
import { lsiForm } from './repair_review_risks_wsession/form.mjs';
import { riskRepairs } from './repair_review_risks_wsession/sections.mjs';
import { task5 } from './repair_review_risks_wsession/text.mjs';

const PROJECT_ID = (await import('#ncbr-settings')).projectId();
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const URL_41 = (await import('#ncbr-settings')).sectionUrl('4_1');
const URL_61 = (await import('#ncbr-settings')).sectionUrl('6_1');
const URL_92 = (await import('#ncbr-settings')).sectionUrl('9_2');
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const session = await WSession.start({ label: 'ncbr_review_risk_repair_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;


const form = lsiForm({ page, email, password });
const { login } = form;
const { repairTask5, repairIndicators92, repairManagement41, readManagement41 } = riskRepairs({ page, URL_41, URL_61, URL_92, ...form });


async function readbackSnippets() {
  const out = {};
  await page.goto(URL_61, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section 6.1 readback
  await humanIdlePause('long');
  out.task61 = await page.evaluate(() => document.querySelector('table')?.innerText.replace(/\s+/g, ' ').trim() || ''); // allow-raw-playwright: read 6.1 table text
  await page.goto(URL_92, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section 9.2 readback
  await humanIdlePause('long');
  out.indicators92 = await page.evaluate(() => document.querySelector('table')?.innerText.replace(/\s+/g, ' ').trim() || ''); // allow-raw-playwright: read 9.2 table text
  return out;
}

await login();
if (process.env.REPAIR_41_ONLY === '1') {
  const repaired41 = await repairManagement41();
  const validation = await validateProject(page, PROJECT_URL);
  console.log(JSON.stringify({ repaired41, validation }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.READ_41_ONLY === '1') {
  const management = await readManagement41();
  console.log(JSON.stringify({ management }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
const repairedTask5 = await repairTask5();
const repairedIndicators92 = await repairIndicators92();
const validation = await validateProject(page, PROJECT_URL);
const snippets = await readbackSnippets();

console.log(JSON.stringify({
  repairedTask5,
  repairedIndicators92: repairedIndicators92.map((r) => ({ name: r.name, filled: r.filled })),
  validation,
  readback: {
    task5Present: snippets.task61.includes(task5.name),
    routineRiskGone: !/Publikacja czterech modeli RNM 1B-70B w formacie HuggingFace transformers z model card/i.test(snippets.task61),
    repeatedBaselineCount: (snippets.indicators92.match(/Wartość bazowa wynosi 0, ponieważ/g) || []).length,
    reportPhraseCount: (snippets.indicators92.match(/raport końcowy/g) || []).length,
  },
}, null, 2));

await session.ctx.close();
process.exit(0);
