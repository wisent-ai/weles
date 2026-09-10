// Strict STEP B criteria repair for the replacement NCBR draft.
// UI-only Weles WSession. Never submits or withdraws the application.

import { WSession } from '../../../../../dist/index.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { lsiForm } from './repair_strict_criteria_wsession/form.mjs';
import { criteriaRepairs } from './repair_strict_criteria_wsession/sections.mjs';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const URLS = {
  '1.2': `${BASE}0ca77e3d-373e-464f-9e9d-a35f5193864d`,
  '2.2': `${BASE}80ebca16-a9dd-4798-a334-5ac007cecbf7`,
  '2.3': `${BASE}c5dbdc83-5baf-4866-b3d8-4da3ae553865`,
  '3.2': `${BASE}06a70163-2dcc-47a0-b64b-201656946538`,
  '6.1': `${BASE}566c735c-8ad0-406f-a948-f3ea921c2cc7`,
  '9.2': `${BASE}e95d0c23-8a39-4d56-96fa-ace3e4f0d23a`,
};
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;

if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const session = await WSession.start({ label: 'ncbr_repair_strict_criteria_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(30000);

const form = lsiForm({ page, email, password });
const { login, fillBySuffix, saveVisibleForm, closeVisibleForm } = form;
const { repairScalarSections, repairTasks61, openIndicatorRowExact, openIndicatorRowByIndex, repairIndicators92 } = criteriaRepairs({ page, ...form, URLS });

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
  const validate = page.getByRole('button', { name: 'Sprawdź wniosek', exact: true }).filter({ visible: true }).first();
  const clicked = await validate.isEnabled().catch(() => false)
    ? (await humanClickLocator(page, validate), { clicked: true })
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

async function readback() {
  const out = {};
  await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read status only
  await humanIdlePause('long');
  out.status = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    return {
      statusLines: body.split('\n').map((l) => l.trim()).filter((l) => /W przygotowaniu|Złożony|Konkurs:/i.test(l)).slice(0, 10),
      submitButtons: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Złóż wniosek').map((b) => ({ disabled: b.disabled })),
    };
  }); // allow-raw-playwright: read application status and submit button state
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read 9.2 table only
  await humanIdlePause('long');
  out.indicators92 = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr')).map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.innerText.trim().replace(/\s+/g, ' ')));
    return rows.map((cells) => ({ name: cells[0], year: cells[4], value: cells[5], methodologyHead: (cells[6] || '').slice(0, 120) }));
  }); // allow-raw-playwright: read 9.2 row cells after save
  await page.goto(URLS['6.1'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read 6.1 table only
  await humanIdlePause('long');
  out.tasks61 = await page.evaluate(() => Array.from(document.querySelectorAll('table tbody tr')).map((r) => (r.querySelector('td')?.innerText || '').trim()).filter(Boolean));
  return out;
}

await login();
if (process.env.DIAG_92) {
  await openIndicatorRowExact(process.env.DIAG_92);
  const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
    name: el.name || null,
    label: el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null,
    value: (el.value || '').slice(0, 220),
    len: (el.value || '').length,
    max: el.getAttribute('maxlength'),
    readOnly: el.readOnly,
    disabled: el.disabled,
    visible: Boolean(el.getClientRects().length),
  })).filter((x) => x.name || x.label)); // allow-raw-playwright: diagnostic read of exact open indicator row only
  console.log(JSON.stringify({ diag92: process.env.DIAG_92, fields }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.DIAG_92_ALL === '1') {
  await page.goto(URLS['9.2'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 9.2 navigation
  await humanIdlePause('long');
  const count = await page.evaluate(() => Array.from(document.querySelectorAll('table tbody tr')).filter((row) => row.querySelector('button[aria-label="overflow-options"]')).length); // allow-raw-playwright: count editable indicator rows only
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    await openIndicatorRowByIndex(i);
    rows.push(await page.evaluate((idx) => {
      const val = (name) => document.querySelector(`[name="${name}"]`)?.value || '';
      return {
        index: idx,
        name: val('nazwa_wskaznika'),
        targetYear: val('rok_osiagniecia_wartosci_docelowej'),
        targetValue: val('wartosc_docelowa'),
        methodologyLen: val('opis_metodologii').length,
        verificationLen: val('opis_sposobu_weryfikacji').length,
        methodologyHead: val('opis_metodologii').slice(0, 120),
      };
    }, i)); // allow-raw-playwright: read exact open indicator row field values
    await closeVisibleForm();
  }
  console.log(JSON.stringify({ rows }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.DIAG_92_INDEX !== undefined) {
  const idx = Number(process.env.DIAG_92_INDEX);
  await openIndicatorRowByIndex(idx);
  const row = await page.evaluate((index) => {
    const val = (name) => document.querySelector(`[name="${name}"]`)?.value || '';
    return {
      index,
      name: val('nazwa_wskaznika'),
      baseYear: val('rok_bazowy'),
      targetYear: val('rok_osiagniecia_wartosci_docelowej'),
      targetValue: val('wartosc_docelowa'),
      methodologyLen: val('opis_metodologii').length,
      verificationLen: val('opis_sposobu_weryfikacji').length,
      methodologyHead: val('opis_metodologii').slice(0, 160),
      verificationHead: val('opis_sposobu_weryfikacji').slice(0, 160),
    };
  }, idx); // allow-raw-playwright: diagnostic read of one 9.2 row by collection-visible index
  console.log(JSON.stringify({ row }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.VALIDATE_ONLY === '1') {
  const validation = await validateProject();
  const evidence = await readback();
  console.log(JSON.stringify({ validation, evidence }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
const only92 = process.env.TAIL_92 === '1' || process.env.ERROR_92 === '1' || process.env.METH_92 === '1' || process.env.REV_92 === '1';
const scalar = only92 ? [] : await repairScalarSections();
const tasks61 = only92 ? [] : await repairTasks61();
const indicators92 = await repairIndicators92();
const validation = await validateProject();
const evidence = await readback();

console.log(JSON.stringify({ scalar, tasks61, indicators92, validation, evidence }, null, 2));
await session.ctx.close();
process.exit(0);
