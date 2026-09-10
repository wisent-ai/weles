// The LSI form helpers of repair_strict_criteria_wsession.mjs, bound to the page they act on.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';

export function lsiForm({ page, email, password }) {
async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanClickLocator(page, locator); // allow-raw-playwright: focus visible LSI input
  const max = Number(await locator.getAttribute('maxlength')) || String(value || '').length;
  let next = String(value || '');
  if (next.length > max) next = next.slice(0, max).replace(/\s+\S*$/, '');
  const locked = await locator.evaluate((el) => Boolean(el.readOnly || el.disabled)); // allow-raw-playwright: inspect visible field mutability
  if (!locked) {
    await humanFill(page, locator, ''); // allow-raw-playwright: clear editable LSI field
    await humanFill(page, locator, next); // allow-raw-playwright: fill editable LSI field
  }
  await locator.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, next); // allow-raw-playwright: set React-controlled LSI value
  await humanIdlePause('short');
  return { len: next.length, max };
}

async function login() {
  await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: LSI login page
  await humanIdlePause('long');
  await setReactInputValue(page.locator('#mail, input[name="mail"]').first(), email);
  await setReactInputValue(page.locator('#password, input[name="password"]').first(), password);
  const statute = page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first();
  if (!await statute.isChecked().catch(() => false)) await humanClickLocator(page, statute.locator('xpath=ancestor-or-self::label[1]').or(statute));
  await humanIdlePause('short');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return !!btn && !btn.disabled;
  }, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for login form validation
  for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
    if (attempt === 1) {
      await humanClickLocator(page, page.locator('#login-btn, button:has-text("Zaloguj")').first()); // allow-raw-playwright: click visible login button
    } else {
      await humanClickLocator(page, page.locator('#login-btn, button:has-text("Zaloguj")').first());
    }
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await humanIdlePause('long');
  }
  if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');
}

async function fillBySuffix(suffix, value) {
  const visible = page.locator(`[name$="${suffix}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name$="${suffix}"]`).last();
  const res = await setReactInputValue(loc, value);
  return { suffix, ...res };
}

async function fillByExactName(name, value) {
  const visible = page.locator(`[name="${name}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name="${name}"]`).last();
  const res = await setReactInputValue(loc, value);
  return { name, ...res };
}

async function saveVisibleForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const save = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true }).last();
  await humanClickLocator(page, save);
  await humanIdlePause('long');
}

async function closeVisibleForm() {
  const cancel = page.getByRole('button', { name: 'Anuluj', exact: true }).filter({ visible: true }).last();
  if (await cancel.count()) await humanClickLocator(page, cancel);
  await humanIdlePause('long');
}

  return { setReactInputValue, login, fillBySuffix, fillByExactName, saveVisibleForm, closeVisibleForm };
}
