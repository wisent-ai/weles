// UI-only repair for budget sections 6.3 and 6.5 in the replacement NCBR STEP B draft.
// Never submits. Uses visible LSI forms only.

import { WSession } from '../../../../../dist/index.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { lsiForm } from './repair_budget_wsession/form.mjs';
import { budgetSections } from './repair_budget_wsession/sections.mjs';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const BASE = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}/projekt_step/`;
const URL_63 = `${BASE}fb417879-403e-4241-a202-ec23c6a6b866`;
const URL_65 = `${BASE}bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b`;
const URL_8 = `${BASE}d31b6d68-33b7-45a0-a032-0f5f02b5aed8`;
const URL_22 = `${BASE}80ebca16-a9dd-4798-a334-5ac007cecbf7`;
const URL_13 = `${BASE}317a21dd-e798-4115-ab53-6ab5a2912fb0`;
const URL_14 = `${BASE}4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc`;
const URL_23 = `${BASE}c5dbdc83-5baf-4866-b3d8-4da3ae553865`;
const URL_61 = `${BASE}566c735c-8ad0-406f-a948-f3ea921c2cc7`;
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;
const KEEP_OPEN = process.env.KEEP_OPEN === '1';

if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const session = await WSession.start({ label: 'ncbr_repair_budget_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(30000);

const form = lsiForm({ page, session, email, password, KEEP_OPEN });
const { finish, login, openRowMenu, clickMenu, saveVisibleForm, tableReadback } = form;
const {
  deleteRows63, rewriteRows63, repairRequiredFields63, rewriteRows65, repair63SecondMethod, repair63GpuNameOnly, repairSection8, repair22MainFactor,
} = budgetSections({ page, ...form, URL_63, URL_65, URL_8, URL_22 });

async function compactReadback() {
  return {
    '1.3': await tableReadback(URL_13),
    '1.4': await tableReadback(URL_14),
    '2.2': await tableReadback(URL_22),
    '2.3': await tableReadback(URL_23),
    '6.1': await tableReadback(URL_61),
    '6.3': await tableReadback(URL_63),
    '6.5': await tableReadback(URL_65),
    '8': await tableReadback(URL_8),
  };
}

async function validateProject() {
  const projectUrl = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
  const responses = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/validate-project')) return;
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    responses.push({ status: res.status(), url: res.url(), text });
  });
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: project page for validation-only action
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
      for (const err of sec.validationResult?.errors || []) {
        jsonSchemaErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message, valueId: err.valueId });
      }
    }
    for (const sec of parsed.expressionValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) {
        expressionErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message, valueId: err.valueId });
      }
    }
  }
  return { clicked, status: response.status, jsonSchemaErrors, expressionErrors, rawHead: response.text.slice(0, 500) };
}

try {
  await login();
  if (process.env.FINAL_BUDGET_REPAIR === '1') {
    const repaired63 = await repair63SecondMethod();
    const repaired8 = await repairSection8();
    const readback63 = await tableReadback(URL_63);
    const readback65 = await tableReadback(URL_65);
    const validation = await validateProject();
    await finish({ repaired63, repaired8, readback63, readback65, validation });
  }
  if (process.env.REPAIR_63_GPU_NAME === '1') {
    const repairedGpuName = await repair63GpuNameOnly();
    const readback63 = await tableReadback(URL_63);
    const validation = await validateProject();
    await finish({ repairedGpuName, readback63, validation });
  }
  if (process.env.DUMP === '1') {
    const readback63 = await tableReadback(URL_63);
    const readback65 = await tableReadback(URL_65);
    await finish({ dumpOnly: true, url: page.url(), readback63, readback65 });
  }
  if (process.env.DUMP_ROW) {
    await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation for row diagnosis
    await humanIdlePause('long');
    await openRowMenu(process.env.DUMP_ROW);
    await clickMenu(/Edytuj/i);
    const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const id = el.id || '';
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : null;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        id,
        label,
        value: el.value || '',
        valueLength: (el.value || '').length,
        max: el.getAttribute('maxlength'),
        readOnly: el.readOnly,
        disabled: el.disabled,
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none',
        y: Math.round(rect.y),
      };
    }).filter((x) => x.name || x.label)); // allow-raw-playwright: read visible edit form fields only
    const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text));
    await finish({ dumpRow: process.env.DUMP_ROW, url: page.url(), fields, buttons });
  }
  if (process.env.REPAIR_63_FIELDS === '1') {
    const repaired = await repairRequiredFields63();
    const readback63 = await tableReadback(URL_63);
    await finish({ repaired, readback63 });
  }

  const deleted63 = await deleteRows63();
  const rewritten63 = await rewriteRows63();
  const repairedFields63 = await repairRequiredFields63();
  const rewritten65 = await rewriteRows65();
  const repaired8 = await repairSection8();
  const repaired22 = await repair22MainFactor();
  const readback63 = await tableReadback(URL_63);
  const readback65 = await tableReadback(URL_65);
  const readback8 = await tableReadback(URL_8);
  const readbackCompact = await compactReadback();
  const validation = process.env.VALIDATE === '1' ? await validateProject() : null;

  await finish({ deleted63, rewritten63, repairedFields63, rewritten65, repaired8, repaired22, readback63, readback65, readback8, readbackCompact, validation });
} catch (error) {
  const errorPayload = {
    error: String(error?.stack || error?.message || error),
    currentUrl: page.url(),
    pageTitle: await page.title().catch(() => null),
    note: 'Nie kliknięto Złóż wniosek. Przy KEEP_OPEN=1 okno zostaje otwarte do diagnozy.',
  };
  await finish(errorPayload, 1);
}
