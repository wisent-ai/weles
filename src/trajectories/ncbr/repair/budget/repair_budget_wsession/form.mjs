// The LSI form helpers of repair_budget_wsession.mjs, bound to the page they act on.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';

export function lsiForm({ page, session, email, password, KEEP_OPEN }) {
async function finish(payload, code = 0) {
  console.log(JSON.stringify(payload, null, 2));
  if (KEEP_OPEN) {
    console.log(`[keep-open] WSession zostaje otwarta; kod wyniku=${code}. Nie kliknięto Złóż wniosek.`);
    await new Promise(() => {});
  }
  await session.ctx.close();
  process.exit(code);
}

async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await humanClickLocator(page, locator); // allow-raw-playwright: focus controlled LSI input
  const locked = await locator.evaluate((el) => Boolean(el.readOnly || el.disabled)); // allow-raw-playwright: inspect controlled field mutability
  if (!locked) {
    await humanFill(page, locator, ''); // allow-raw-playwright: clear controlled LSI input
    await humanFill(page, locator, value); // allow-raw-playwright: fill controlled LSI input
  }
  await locator.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, value); // allow-raw-playwright: set controlled LSI field value
  await humanIdlePause('short');
}

async function login() {
  await page.goto('https://lsi2.ncbr.gov.pl/logowanie', { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: LSI login navigation
  await humanIdlePause('long');
  await setReactInputValue(page.locator('#mail, input[name="mail"]').first(), email);
  await setReactInputValue(page.locator('#password, input[name="password"]').first(), password);
  const statute = page.locator('#isStatuteAccepted, input[name="isStatuteAccepted"]').first();
  if (!await statute.isChecked().catch(() => false)) await humanClickLocator(page, statute.locator('xpath=ancestor-or-self::label[1]').or(statute));
  await humanIdlePause('short');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return !!btn && !btn.disabled;
  }, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for login validation
  const formState = await page.evaluate(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return {
      emailLen: (document.querySelector('#mail, input[name="mail"]')?.value || '').length,
      passwordLen: (document.querySelector('#password, input[name="password"]')?.value || '').length,
      checked: Boolean(document.querySelector('#isStatuteAccepted, input[name="isStatuteAccepted"]')?.checked),
      loginDisabled: btn ? btn.disabled : null,
    };
  }); // allow-raw-playwright: read safe login form state
  console.log(`[login] ${JSON.stringify(formState)}`);
  if (formState.loginDisabled) throw new Error(`login button disabled: ${JSON.stringify(formState)}`);
  for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
    console.log(`[login click] attempt ${attempt}`);
    if (attempt === 1) {
      await humanClickLocator(page, page.locator('#login-btn, button:has-text("Zaloguj")').first()); // allow-raw-playwright: visible login button only
    } else {
      await humanClickLocator(page, page.locator('#login-btn, button:has-text("Zaloguj")').first());
    }
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await humanIdlePause('long');
  }
  if (page.url().includes('/logowanie')) {
    const body = await page.locator('body').innerText().catch(() => '');
    throw new Error(`login stayed on login page: ${body.slice(0, 500).replace(/\s+/g, ' ')}`);
  }
}

async function openRowMenu(match) {
  const row = page.locator('table').first().locator('tbody tr').filter({ hasText: match }).first();
  if (await row.count() === 0) throw new Error(`row not found: ${match}`);
  await row.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open visible row overflow menu
  await humanIdlePause('deliberate');
}

async function clickMenu(label) {
  const item = page.locator('[role="menuitem"], .MuiMenuItem-root').filter({ hasText: label }).first();
  if (await item.count() === 0) {
    const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], .MuiMenuItem-root, [role="menu"]')).map((e) => e.textContent.trim()).filter(Boolean));
    throw new Error(`menu item not found: ${label}; saw ${menu.join(' | ')}`);
  }
  await item.dispatchEvent('click'); // allow-raw-playwright: choose visible row menu item
  await humanIdlePause('long');
}

async function fill(name, value) {
  const visible = page.locator(`[name="${name}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name="${name}"]`).last();
  await setReactInputValue(loc, String(value));
}

async function typeFill(name, value) {
  const visible = page.locator(`[name="${name}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`[name="${name}"]`).last();
  await loc.waitFor({ state: 'visible' });
  await loc.scrollIntoViewIfNeeded(); // allow-raw-playwright: keep visible LSI textarea focused for text insertion
  await humanClickLocator(page, loc); // allow-raw-playwright: focus visible LSI field before human typing
  await humanFill(page, loc, String(value)); // allow-raw-playwright: fill visible editable LSI textarea with Playwright input events
  await humanIdlePause('short');
}

async function saveVisibleForm({ allowNoChange = false } = {}) {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const save = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true }).last();
  const clicked = await save.isEnabled().catch(() => false);
  if (clicked) await humanClickLocator(page, save);
  else if (!allowNoChange) throw new Error('no enabled visible Zapisz');
  if (clicked) await humanIdlePause('long');
  return clicked ? 'saved' : 'no_change';
}
async function tableReadback(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: read-only budget table navigation
  await humanIdlePause('long');
  return await page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table) => ({
    rows: table.querySelectorAll('tbody tr').length,
    text: table.innerText.replace(/\s+/g, ' ').trim(),
  }))); // allow-raw-playwright: read table text only
}

async function clickVisibleButton(text) {
  const button = page.getByRole('button', { name: text, exact: true }).filter({ visible: true }).first();
  await humanClickLocator(page, button);
  await humanIdlePause('long');
}
async function selectVisibleOption(match) {
  const option = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: match }).first();
  if (await option.count() === 0) {
    const seen = await page.evaluate(() => Array.from(document.querySelectorAll("[role='listbox'] [role='option'], [role='option']")).map((o) => o.textContent.trim()).filter(Boolean).slice(0, 20));
    throw new Error(`option not found: ${match}; saw ${seen.join(' | ')}`);
  }
  await option.dispatchEvent('click'); // allow-raw-playwright: choose visible MUI option in open listbox
  await humanIdlePause('short');
  return (await option.textContent())?.trim() || '';
}
  return { finish, setReactInputValue, login, openRowMenu, clickMenu, fill, typeFill, saveVisibleForm, tableReadback, clickVisibleButton, selectVisibleOption };
}
