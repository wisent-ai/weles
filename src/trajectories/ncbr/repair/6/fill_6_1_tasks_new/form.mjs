// The 6.1 task row form, bound to the page: adding a row, the named and selector fields,
// the pre-save check, the radio and applicant choices, saving, and opening a task row.
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../../../../dist/human/mouse.js';
import { openNewRow, openRowEditor } from '../../../forms/row-editor.mjs';
import { fillField, selectRadio } from '../../../form-input.mjs';

export function tasksForm({ page, SECTION_URL }) {
  async function clickDodaj() {
    const button = page
      .getByRole('button', { name: 'Dodaj', exact: true })
      .filter({ visible: true })
      .first();
    await openNewRow(page, button, page.locator('[name="numer_zadania"]'));
  }

  async function fillByName(name, value) {
    const loc = page.locator(`[name="${name}"]`).first();
    const observed = await fillField(page, loc, value);
    return `${name} ${observed.len}/${observed.max}`;
  }

  async function fillSelector(selector, value) {
    const loc = page.locator(selector).first();
    await fillField(page, loc, value);
  }

  async function assertTaskValuesBeforeSave(nr) {
    const state = await page.evaluate(() => {
      const value = (name) =>
        document.querySelector(`[name="${name}"]`)?.value || '';
      const milestoneLens = Array.from(
        document.querySelectorAll(
          'textarea[name^="kamienie_milowe_kolekcja["]',
        ),
      ).map((el) => ({ name: el.name, len: (el.value || '').length }));
      return {
        zakres: value('zakres_planowanych_prac_br').length,
        szczegolowy: value('szczegolowy_opis_prac').length,
        milestoneLens,
      };
    }); // allow-raw-playwright: verify filled values before saving task row
    const badMilestone = state.milestoneLens.find((x) => x.len < 80);
    if (state.zakres < 500 || state.szczegolowy < 500 || badMilestone) {
      throw new Error(
        `task ${nr} not filled before save: zakres=${state.zakres}, szczegolowy=${state.szczegolowy}, bad=${badMilestone ? `${badMilestone.name}:${badMilestone.len}` : 'none'}`,
      );
    }
    return state;
  }

  async function radio(value) {
    await selectRadio(
      page,
      page.locator(`input[type="radio"][value="${value}"]`).first(),
    );
  }

  async function setApplicant() {
    const visible = page
      .locator(
        '#nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta',
      )
      .first();
    if ((await visible.count()) > 0) {
      await humanClickLocator(page, visible); // allow-raw-playwright: open visible MUI Select
    } else {
      const select = page
        .locator(
          `input[name="nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta"]`,
        )
        .first()
        .locator('xpath=ancestor::*[contains(@class,"MuiInputBase-root")][1]')
        .locator('.MuiSelect-select, [role="combobox"]')
        .first();
      if ((await select.count()) > 0) await humanClickLocator(page, select); // allow-raw-playwright: open applicant select
    }
    await humanIdlePause('deliberate');
    const opt = page
      .getByRole('option', { name: 'Wisent Polska', exact: true })
      .first();
    if ((await opt.count()) > 0)
      await humanClickLocator(page, opt); // allow-raw-playwright: select applicant
    else throw new Error('Wisent Polska applicant option not found');
    await humanIdlePause('short');
  }

  async function saveForm() {
    await humanIdlePause('deliberate');
    await humanIdlePause('deliberate');
    await humanClickLocator(
      page,
      page
        .locator('button:not([disabled])')
        .filter({ hasText: /^Zapisz$/ })
        .last(),
    ); // allow-raw-playwright: save task sub-form
    await humanIdlePause('long');
  }

  async function editTaskRow(nr) {
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' });
    const number = String(nr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = page
      .locator('table tbody tr')
      .filter({ hasText: new RegExp(`^${number}\\. `) })
      .first();
    await openRowEditor(page, row, page.locator('[name="numer_zadania"]'));
  }
  return {
    clickDodaj,
    fillByName,
    fillSelector,
    assertTaskValuesBeforeSave,
    radio,
    setApplicant,
    saveForm,
    editTaskRow,
  };
}
