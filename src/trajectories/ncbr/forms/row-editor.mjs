import { humanClickLocator } from '../../../../dist/human/mouse.js';

async function clickEnabled(page, control, operation) {
  await control.waitFor({ state: 'visible' });
  if (!(await control.isEnabled()) || await control.getAttribute('aria-disabled') === 'true') {
    throw Object.assign(new Error(`NCBR row editor control is disabled: ${operation}`), {
      code: 'LSI_ROW_EDITOR_CONTROL_DISABLED', operation, pageUrl: page.url(),
    });
  }
  await humanClickLocator(page, control);
}

// The caller selects the row and owns the page. This transition opens its
// offered editor and returns the field whose visibility established entry;
// it neither writes a value nor treats an open editor as a saved row.
export async function openRowEditor(page, row, fieldName) {
  const menu = row.locator('button[aria-label="overflow-options"]').filter({ visible: true }).first();
  await clickEnabled(page, menu, 'open_row_menu');
  const edit = page.getByRole('menuitem', { name: 'Edytuj', exact: true }).filter({ visible: true }).first();
  await clickEnabled(page, edit, 'open_row_editor');
  const field = page.locator(`[name=${JSON.stringify(fieldName)}]`).filter({ visible: true }).first();
  await field.waitFor({ state: 'visible' });
  return field;
}
