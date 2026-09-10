// The LSI form helpers of repair_review_risks_wsession.mjs, bound to the page they act on.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';

export function lsiForm({ page, email, password }) {
async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanClickLocator(page, locator);
  const locked = await locator.evaluate((el) => Boolean(el.readOnly || el.disabled)); // allow-raw-playwright: inspect controlled field mutability
  if (!locked) {
    await humanFill(page, locator, '');
    await humanFill(page, locator, value)
  }
  await humanIdlePause('short');
}

async function login() {
  await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: LSI login navigation
  await humanIdlePause('long');
  await setReactInputValue(page.locator('#mail, input[name="mail"]').first(), email);
  await setReactInputValue(page.locator('#password, input[name="password"]').first(), password);
  const statute = page.locator('label:has(#isStatuteAccepted), label:has(input[name="isStatuteAccepted"]), #isStatuteAccepted, input[name="isStatuteAccepted"]:visible').first();
  if (await statute.count() && !await page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first().isChecked()) await humanClickLocator(page, statute);
  await humanIdlePause('short');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return !!btn && !btn.disabled;
  }, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for login validation
  await humanClickLocator(page, page.locator('#login-btn, button:has-text("Zaloguj")').first());
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
  await humanIdlePause('long');
  if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');
}

async function saveVisibleForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const saveCount = await saves.count();
  if (!saveCount) throw new Error('no enabled visible Zapisz');
  await humanClickLocator(page, saves.nth(saveCount - 1));
  await humanIdlePause('long');
}

async function fillByName(name, value) {
  const visible = page.locator(`[name="${name}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name="${name}"]`).last();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  let next = String(value || '');
  if (next.length > max) next = next.slice(0, max).replace(/\s+\S*$/, '');
  await setReactInputValue(loc, next);
  return { name, len: next.length, max };
}

async function fillBySuffix(suffix, value) {
  const visible = page.locator(`[name$="${suffix}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name$="${suffix}"]`).last();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value || '').length;
  let next = String(value || '');
  if (next.length > max) next = next.slice(0, max).replace(/\s+\S*$/, '');
  await setReactInputValue(loc, next);
  return { suffix, len: next.length, max };
}

  return { setReactInputValue, login, saveVisibleForm, fillByName, fillBySuffix };
}
