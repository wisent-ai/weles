// The LSI form helpers of repair_contacts_2_2_wsession.mjs, bound to the page they act on.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { EDORECZENIA } from './source.mjs';

export function lsiForm({ page, session, email, password, progress }) {
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
  }, next); // allow-raw-playwright: set React-controlled LSI field value
  await humanIdlePause('short');
  return { len: next.length, max };
}

async function login() {
  progress('login:start');
  await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: LSI login page
  await humanIdlePause('long');
  await setReactInputValue(page.locator('#mail, input[name="mail"]').first(), email);
  await setReactInputValue(page.locator('#password, input[name="password"]').first(), password);
  const checkbox = page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first();
  if (!(await checkbox.isChecked().catch(() => false))) await humanClickLocator(page, checkbox) // allow-raw-playwright: accept visible statute checkbox for login only
  await humanIdlePause('short');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return !!btn && !btn.disabled;
  }, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for login validation
  for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
    await session.clickSelector('#login-btn, button:has-text("Zaloguj")'); // allow-raw-playwright: click visible login button
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await humanIdlePause('long');
  }
  if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');
  progress('login:done');
}

async function clickVisibleButton(text, nth = 0) {
  const buttons = page.locator('button:visible').filter({ hasText: new RegExp(`^${text}$`) });
  if (await buttons.count() <= nth) throw new Error(`${text} #${nth} not found`);
  await humanClickLocator(page, buttons.nth(nth)) // allow-raw-playwright: click visible LSI button
  await humanIdlePause('long');
}

async function saveVisibleForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length), null, { timeout: 25000 }).catch(() => null); // allow-raw-playwright: wait for enabled LSI save
  await humanClickLocator(page, page.locator('button:visible:not([disabled])').filter({ hasText: /^Zapisz$/ }).last()) // allow-raw-playwright: save visible row/form only
  await humanIdlePause('long');
}

async function fillAny(names, value) {
  for (const name of names) {
    const visible = page.locator(`input[name="${name}"]:visible, textarea[name="${name}"]:visible`);
    const loc = (await visible.count() > 0) ? visible.last() : page.locator(`input[name="${name}"], textarea[name="${name}"]`).last();
    if (await loc.count() === 0) continue;
    return { name, ...(await setReactInputValue(loc, value)) };
  }
  throw new Error(`none of fields found: ${names.join(', ')}`);
}

async function fillByName(name, value) {
  return fillAny([name], value);
}

async function deleteRowsContaining(needle) {
  const deleted = [];
  while (await page.evaluate((text) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('table tbody tr')).some((r) => norm(r.innerText).includes(text));
  }, needle)) {
    progress(`1.3:delete:${needle}`);
    const row = page.locator('table tbody tr').filter({ hasText: needle }).first();
    await humanClickLocator(page, row.locator('button[aria-label="overflow-options"]')) // allow-raw-playwright: open stale visible row menu
    await humanIdlePause('deliberate');
    const del = page.locator('[role="menuitem"], .MuiMenuItem-root').filter({ hasText: /Usuń|Usun|Delete/ }).first();
    if (await del.count() === 0) throw new Error(`delete menu item not found for ${needle}`);
    await del.dispatchEvent('click'); // allow-raw-playwright: delete stale visible row
    await humanIdlePause('deliberate');
    const confirm = page.locator('button').filter({ hasText: /Usuń|Usun|Potwierdź|Tak|Delete/ }).last();
    if (await confirm.count() > 0) await confirm.dispatchEvent('click'); // allow-raw-playwright: confirm visible delete dialog
    await humanIdlePause('long');
    deleted.push(needle);
  }
  return deleted;
}

async function fillEdoreczeniaIfPresent() {
  const result = await page.evaluate((value) => {
    const fields = Array.from(document.querySelectorAll('input, textarea'));
    const hit = fields.find((el) => {
      const id = el.id || '';
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || '' : '';
      const hay = `${el.name || ''} ${label} ${el.placeholder || ''}`.toLowerCase();
      return hay.includes('doręc') || hay.includes('dorec') || hay.includes('ae:');
    });
    if (!hit || hit.disabled || hit.readOnly) return { found: Boolean(hit), filled: false };
    const proto = hit instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(hit, value);
    else hit.value = value;
    hit.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    hit.dispatchEvent(new Event('change', { bubbles: true }));
    hit.dispatchEvent(new Event('blur', { bubbles: true }));
    return { found: true, filled: true, name: hit.name || null, id: hit.id || null };
  }, EDORECZENIA); // allow-raw-playwright: fill visible e-Doreczenia field if present
  return result;
}
  return { setReactInputValue, login, clickVisibleButton, saveVisibleForm, fillAny, fillByName, deleteRowsContaining, fillEdoreczeniaIfPresent };
}
