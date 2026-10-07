// The LSI form helpers of repair_review_risks_wsession.mjs, bound to the page they act on.
import {
  humanClickLocator,
  humanIdlePause,
} from '../../../../../../dist/human/mouse.js';
import { fillField } from '../../../form-input.mjs';

export function lsiForm({ page, email, password }) {
  async function login() {
    await page.goto('https://lsi2.ncbr.gov.pl/logowanie', {
      waitUntil: 'domcontentloaded',
    }); // allow-raw-playwright: LSI login navigation
    await fillField(
      page,
      page.locator('#mail, input[name="mail"]').first(),
      email,
    );
    await fillField(
      page,
      page.locator('#password, input[name="password"]').first(),
      password,
    );
    const statute = page
      .locator(
        'label:has(#isStatuteAccepted), label:has(input[name="isStatuteAccepted"]), #isStatuteAccepted, input[name="isStatuteAccepted"]:visible',
      )
      .first();
    if (
      (await statute.count()) &&
      !(await page
        .locator('#isStatuteAccepted, input[name="isStatuteAccepted"]')
        .first()
        .isChecked())
    )
      await humanClickLocator(page, statute);
    await page.waitForFunction(
      () => {
        const btn =
          document.querySelector('#login-btn') ||
          Array.from(document.querySelectorAll('button')).find(
            (b) => b.innerText.trim() === 'Zaloguj',
          );
        return !!btn && !btn.disabled;
      },
      null,
      { polling: 'raf' },
    ); // allow-raw-playwright: wait for login validation
    await humanClickLocator(
      page,
      page.locator('#login-btn, button:has-text("Zaloguj")').first(),
    );
    await page.waitForLoadState('load');
    await humanIdlePause('long');
    if (page.url().includes('/logowanie'))
      throw new Error('login stayed on login page');
  }

  async function saveVisibleForm() {
    const save = page
      .getByRole('button', { name: 'Zapisz', exact: true })
      .and(page.locator('button:not(:disabled):not([aria-disabled="true"])'))
      .filter({ visible: true })
      .last();
    await save.waitFor({ state: 'visible' });
    await humanClickLocator(page, save);
    await humanIdlePause('long');
  }

  async function fillByName(name, value) {
    const visible = page.locator(`[name="${name}"]:visible`);
    const loc =
      (await visible.count()) > 0
        ? visible.last()
        : page.locator(`[name="${name}"]`).last();
    const result = await fillField(page, loc, value);
    return { name, ...result };
  }

  async function fillBySuffix(suffix, value) {
    const visible = page.locator(`[name$="${suffix}"]:visible`);
    const loc =
      (await visible.count()) > 0
        ? visible.last()
        : page.locator(`[name$="${suffix}"]`).last();
    const result = await fillField(page, loc, value);
    return { suffix, ...result };
  }

  return { login, saveVisibleForm, fillByName, fillBySuffix };
}
