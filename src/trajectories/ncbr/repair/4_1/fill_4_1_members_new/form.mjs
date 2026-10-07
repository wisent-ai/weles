// The 4.1 member row form, bound to the page: adding a row, the named fields and
// autocompletes, the applicant and status choices, saving, the project sub-row and
// opening an existing member row.
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { openNewRow, openRowEditor } from '../../../forms/row-editor.mjs';
import { assertFits, selectRadio } from '../../../form-input.mjs';

export function membersForm({ page, SECTION_URL }) {
  async function clickDodaj() {
    const button = page
      .getByRole('button', { name: 'Dodaj', exact: true })
      .filter({ visible: true })
      .first();
    await openNewRow(page, button, page.locator('[name="imie"]'));
  }

  async function fillByName(name, value) {
    const loc = page.locator(`[name="${name}"]`).first();
    await loc.waitFor({ state: 'visible' });
    let v = value || '';
    const max = await assertFits(loc, v);
    await humanFill(page, loc, v);
    return `${name} ${v.length}/${max}`;
  }

  async function setAuto(name, search) {
    const inp = page.locator(`input[name="${name}"]`).first();
    await humanClickLocator(page, inp);
    await humanFill(page, inp, search);
    await humanIdlePause('deliberate');
    const opt = page.locator("[role='listbox'] [role='option']").first();
    if ((await opt.count()) === 0)
      throw new Error(`no option for ${name} -> ${search}`);
    const picked = (await opt.textContent())?.trim();
    await opt.dispatchEvent('click'); // allow-raw-playwright: pick filtered option
    await humanIdlePause('short');
    return picked;
  }

  async function setApplicant() {
    const applicant = page
      .locator(
        "input[name='nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta']",
      )
      .locator('xpath=ancestor::*[contains(@class, "MuiInputBase-root")][1]')
      .locator('.MuiSelect-select, [role="combobox"]')
      .first();
    if ((await applicant.count()) === 0)
      throw new Error('applicant select not found');
    await humanClickLocator(page, applicant);
    await humanIdlePause('deliberate');
    const opt = page
      .getByRole('option', { name: 'Wisent Polska', exact: true })
      .first();
    if ((await opt.count()) > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: select applicant
    await humanIdlePause('short');
  }

  async function setStatus() {
    const value = 'pracownik_wnioskodawcy_samodzielnego_lidera_konsorcjum';
    await selectRadio(
      page,
      page.locator(`input[type="radio"][value="${value}"]`).first(),
    );
  }

  async function saveForm() {
    await humanIdlePause('deliberate');
    await humanIdlePause('deliberate');
    const saves = page
      .getByRole('button', { name: 'Zapisz', exact: true })
      .filter({ visible: true });
    if ((await saves.count()) === 0) throw new Error('no enabled Zapisz');
    await humanClickLocator(page, saves.last());
    await humanIdlePause('long');
  }

  async function fillProjectSubrow(project, addIdx = 0) {
    const adds = page
      .getByRole('button', { name: 'Dodaj kolejny', exact: true })
      .filter({ visible: true });
    if ((await adds.count()) <= addIdx)
      throw new Error(`Dodaj kolejny ${addIdx} not found`);
    await humanClickLocator(page, adds.nth(addIdx));
    await humanIdlePause('long');

    const fillNested = async (suffix, value) => {
      const loc = page.locator(`[name$="${suffix}"]`).first();
      await loc.waitFor({ state: 'visible' });
      let v = String(value || '');
      await assertFits(loc, v);
      await humanFill(page, loc, v);
    };

    await fillNested('zrealizowane_projekty_tytul', project.tytul);
    await fillNested('zrealizowane_projekty_budzet', project.budzet);
    await fillNested('zrealizowane_projekty_numer_projektu', project.numer);
    await fillNested('zrealizowane_projekty_okres_realizacji_od', project.od);
    await fillNested('zrealizowane_projekty_okres_realizacji_do', project.do);
    const consortiumValue = project.konsorcjum === 'Tak' ? 'Tak' : 'Nie';
    await selectRadio(
      page,
      page.locator(`input[type="radio"][value="${consortiumValue}"]`).first(),
    );
    await fillNested(
      'zrealizowane_projekty_rola_w_zrealizowanym_projekcie',
      project.rola,
    );
    await fillNested('zrealizowane_projekty_glowne_efekty', project.efekty);
    await saveForm();
  }

  async function editMemberRow(index) {
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
    const row = page.locator('table tbody tr').nth(index + 1);
    await openRowEditor(page, row, page.locator('[name="imie"]'));
  }
  return {
    clickDodaj,
    fillByName,
    setAuto,
    setApplicant,
    setStatus,
    saveForm,
    fillProjectSubrow,
    editMemberRow,
  };
}
