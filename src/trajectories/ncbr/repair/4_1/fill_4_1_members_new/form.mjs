// The 4.1 member row form, bound to the page: adding a row, the named fields and
// autocompletes, the applicant and status choices, saving, the project sub-row and
// opening an existing member row.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';

export function membersForm({ page, SECTION_URL }) {
async function clickDodaj() {
  const button = page.getByRole('button', { name: 'Dodaj', exact: true }).first();
  if (await button.count() === 0) throw new Error('Dodaj not found');
  await humanClickLocator(page, button);
  await humanIdlePause('long');
}

async function fillByName(name, value) {
  const loc = page.locator(`[name="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || value.length;
  let v = value || '';
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await humanFill(page, loc, v);
  await humanIdlePause('short');
  return `${name} ${v.length}/${max}`;
}

async function setAuto(name, search) {
  const inp = page.locator(`input[name="${name}"]`).first();
  await humanClickLocator(page, inp);
  await humanFill(page, inp, search);
  await humanIdlePause('deliberate');
  const opt = page.locator("[role='listbox'] [role='option']").first();
  if (await opt.count() === 0) throw new Error(`no option for ${name} -> ${search}`);
  const picked = (await opt.textContent())?.trim();
  await opt.dispatchEvent('click'); // allow-raw-playwright: pick filtered option
  await humanIdlePause('short');
  return picked;
}

async function setApplicant() {
  const applicant = page.locator("input[name='nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta']")
    .locator('xpath=ancestor::*[contains(@class, "MuiInputBase-root")][1]')
    .locator('.MuiSelect-select, [role="combobox"]').first();
  if (await applicant.count() === 0) throw new Error('applicant select not found');
  await humanClickLocator(page, applicant);
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: select applicant
  await humanIdlePause('short');
}

async function setStatus() {
  const value = 'pracownik_wnioskodawcy_samodzielnego_lidera_konsorcjum';
  await page.locator(`input[type="radio"][value="${value}"]`).first().dispatchEvent('click'); // allow-raw-playwright: status radio
  await humanIdlePause('short');
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  if (await saves.count() === 0) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.last());
  await humanIdlePause('long');
}

async function fillProjectSubrow(project, addIdx = 0) {
  const adds = page.getByRole('button', { name: 'Dodaj kolejny', exact: true }).filter({ visible: true });
  if (await adds.count() <= addIdx) throw new Error(`Dodaj kolejny ${addIdx} not found`);
  await humanClickLocator(page, adds.nth(addIdx));
  await humanIdlePause('long');

  const fillNested = async (suffix, value) => {
    const loc = page.locator(`[name$="${suffix}"]`).first();
    await loc.waitFor({ state: 'visible' });
    const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
    let v = String(value || '');
    if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
    await humanFill(page, loc, v);
    await humanIdlePause('short');
  };

  await fillNested('zrealizowane_projekty_tytul', project.tytul);
  await fillNested('zrealizowane_projekty_budzet', project.budzet);
  await fillNested('zrealizowane_projekty_numer_projektu', project.numer);
  await fillNested('zrealizowane_projekty_okres_realizacji_od', project.od);
  await fillNested('zrealizowane_projekty_okres_realizacji_do', project.do);
  const consortiumValue = project.konsorcjum === 'Tak' ? 'Tak' : 'Nie';
  await page.locator(`input[type="radio"][value="${consortiumValue}"]`).first().dispatchEvent('click'); // allow-raw-playwright: project consortium radio
  await humanIdlePause('short');
  await fillNested('zrealizowane_projekty_rola_w_zrealizowanym_projekcie', project.rola);
  await fillNested('zrealizowane_projekty_glowne_efekty', project.efekty);
  await saveForm();
}

async function editMemberRow(index) {
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  const row = page.locator('table tbody tr').nth(index + 1);
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open member row menu
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit member row
  await humanIdlePause('long');
  await page.waitForSelector('[name="imie"]');
}
  return { clickDodaj, fillByName, setAuto, setApplicant, setStatus, saveForm, fillProjectSubrow, editMemberRow };
}
