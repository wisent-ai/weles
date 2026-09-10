// Targeted review-risk repair for the replacement NCBR STEP B draft.
// Edits only 6.1 task 5 and selected 9.2 indicator descriptions. Never submits.

import { WSession } from '../../../../../dist/index.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { lsiForm } from './repair_review_risks_wsession/form.mjs';
import { riskRepairs } from './repair_review_risks_wsession/sections.mjs';
import { task5 } from './repair_review_risks_wsession/text.mjs';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const URL_41 = `${BASE}5af236aa-03b2-4650-b5a2-95c299dfeeaf`;
const URL_61 = `${BASE}566c735c-8ad0-406f-a948-f3ea921c2cc7`;
const URL_92 = `${BASE}e95d0c23-8a39-4d56-96fa-ace3e4f0d23a`;
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const session = await WSession.start({ label: 'ncbr_review_risk_repair_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(30000);

const form = lsiForm({ page, email, password });
const { login } = form;
const { repairTask5, repairIndicators92, repairManagement41, readManagement41 } = riskRepairs({ page, URL_41, URL_61, URL_92, ...form });

async function validateProject() {
  const responses = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/validate-project')) return;
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    responses.push({ status: res.status(), url: res.url(), text });
  });
  await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: project page for validation-only action
  await humanIdlePause('long');
  const validateButton = page.getByRole('button', { name: 'Sprawdź wniosek', exact: true }).filter({ visible: true }).first();
  const clicked = await validateButton.count() && !await validateButton.isDisabled()
    ? await humanClickLocator(page, validateButton).then(() => ({ clicked: true }))
    : { clicked: false, reason: 'enabled Sprawdz wniosek button not found' };
  await humanIdlePause('long');
  await humanIdlePause('long');
  await humanIdlePause('long');
  const response = responses.at(-1) || null;
  if (!response) return { clicked, response: null };
  let parsed = null;
  try { parsed = JSON.parse(response.text); } catch {}
  const jsonSchemaErrors = [];
  const expressionErrors = [];
  if (parsed) {
    for (const sec of parsed.jsonSchemaValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) jsonSchemaErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message });
    }
    for (const sec of parsed.expressionValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) expressionErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message });
    }
  }
  return { clicked, status: response.status, jsonSchemaErrors, expressionErrors, rawHead: response.text.slice(0, 500) };
}

async function readbackSnippets() {
  const out = {};
  await page.goto(URL_61, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 6.1 readback
  await humanIdlePause('long');
  out.task61 = await page.evaluate(() => document.querySelector('table')?.innerText.replace(/\s+/g, ' ').trim() || ''); // allow-raw-playwright: read 6.1 table text
  await page.goto(URL_92, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 9.2 readback
  await humanIdlePause('long');
  out.indicators92 = await page.evaluate(() => document.querySelector('table')?.innerText.replace(/\s+/g, ' ').trim() || ''); // allow-raw-playwright: read 9.2 table text
  return out;
}

await login();
if (process.env.REPAIR_41_ONLY === '1') {
  const repaired41 = await repairManagement41();
  const validation = await validateProject();
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
const validation = await validateProject();
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
