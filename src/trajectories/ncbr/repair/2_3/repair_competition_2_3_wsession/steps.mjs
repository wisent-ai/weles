// The 1.4 and 2.3 row steps of repair_competition_2_3_wsession.mjs, bound to the page and the form helpers.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { competitors14 } from './source.mjs';

export function competitionSteps({ page, progress, URLS, PROJECT_URL, setReactInputValue, visibleTableText, hasAnyName, clickDodaj, saveVisibleForm, selectApplicantIfPresent, fillNamedField, fillBySuffix }) {
async function addCompetitor14(row) {
  progress(`1.4:add:${row.name}`);
  await clickDodaj(0);
  await page.waitForSelector('[name="nazwa_podmiotu_konkurencyjnego"]');
  const applicant = await selectApplicantIfPresent();
  const fields = [];
  fields.push(await fillNamedField('nazwa_podmiotu_konkurencyjnego', row.name));
  fields.push(await fillNamedField('nip', row.nip));
  fields.push(await fillNamedField('opis', row.desc));
  await saveVisibleForm();
  return { added: row.name, applicant, fields };
}

async function addCompetition23(tableIndex, row) {
  progress(`2.3:add-competition:${row.producer}`);
  await clickDodaj(tableIndex);
  const fields = [];
  fields.push(await fillNamedField('produkt_proces', `${row.product}\n\nFunkcjonalności: ${row.functions}`));
  fields.push(await fillNamedField('nazwa_producenta', row.producer));
  fields.push(await fillNamedField('korzysc_przewaga', row.advantage));
  await saveVisibleForm();
  return { added: row.producer, fields };
}

async function dumpOpenFields() {
  return page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
    tag: el.tagName,
    name: el.name || null,
    type: el.type || null,
    max: el.getAttribute('maxlength'),
    value: (el.value || '').slice(0, 100),
    visible: Boolean(el.getClientRects().length),
  })).filter((field) => field.name || field.value)); // allow-raw-playwright: diagnostic read of open row fields
}

async function addParameter23(row) {
  progress(`2.3:add-parameter:${row.name}`);
  await clickDodaj(2);
  const fields = [];
  fields.push(await fillBySuffix('nazwa_parametru', row.name));
  fields.push(await fillBySuffix('wartosc_bazowa', row.baseValue));
  fields.push(await fillBySuffix('rok_bazowy', row.baseYear));
  fields.push(await fillBySuffix('wartosc_docelowa', row.targetValue));
  fields.push(await fillBySuffix('rok_docelowy', row.targetYear));
  fields.push(await fillBySuffix('metoda_szacowania_wartosci_docelowej', row.estimate));
  fields.push(await fillBySuffix('sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych', row.verify));
  await saveVisibleForm();
  return { added: row.name, fields };
}

async function editVisibleRowContaining(text) {
  const row = page.locator('table tbody tr').filter({ hasText: text }).first();
  if (await row.count() === 0) throw new Error(`visible row not found: ${text}`);
  await humanClickLocator(page, row.locator('button[aria-label="overflow-options"]')) // allow-raw-playwright: open visible collection row menu by exact row text
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit selected visible row
  await humanIdlePause('long');
}

async function repairVisibleMissingNips14() {
  await page.goto(URLS['1.4'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 1.4 navigation for row repair
  await humanIdlePause('long');
  const repaired = [];
  for (const row of competitors14) {
    const rowText = await page.evaluate((names) => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      const hit = rows.find((candidate) => names.some((name) => (candidate.innerText || '').includes(name)));
      return hit ? (hit.innerText || '').replace(/\s+/g, ' ').trim() : null;
    }, [row.name, ...(row.aliases || [])]); // allow-raw-playwright: read matching visible row text
    if (!rowText || rowText.includes(row.nip)) continue;
    progress(`1.4:repair-nip:${row.name}`);
    await editVisibleRowContaining((row.aliases || [row.name]).find((name) => rowText.includes(name)) || row.name);
    await fillNamedField('nip', row.nip);
    await saveVisibleForm();
    repaired.push(row.name);
    await page.goto(URLS['1.4'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: reload table after row repair
    await humanIdlePause('long');
  }
  return repaired;
}

async function validateProject() {
  progress('validate:start');
  const responses = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/validate-project')) return;
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    responses.push({ status: res.status(), url: res.url(), text });
  });
  await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: validation-only project navigation
  await humanIdlePause('long');
  const btn = page.locator('button:not([disabled])').filter({ hasText: /^Sprawdź wniosek$/ }).first();
  const clicked = { clicked: await btn.count() > 0, reason: await btn.count() > 0 ? undefined : 'enabled Sprawdz wniosek button not found' };
  if (clicked.clicked) await humanClickLocator(page, btn); // allow-raw-playwright: validation-only; never submit
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

  return { addCompetitor14, addCompetition23, dumpOpenFields, addParameter23, editVisibleRowContaining, repairVisibleMissingNips14, validateProject };
}
