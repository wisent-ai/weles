// The section 2.2 collection forms, bound to the page: opening a row form, filling its
// fields by name or suffix, picking an autocomplete value, and saving.
import { humanClickLocator, humanIdlePause } from '../../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../../dist/human/keyboard.js';

export function collectionsForm({ page }) {
async function clickDodaj(nth = 0) {
  const buttons = page.getByRole('button', { name: 'Dodaj', exact: true }).filter({ visible: true });
  if (await buttons.count() <= nth) throw new Error(`Dodaj #${nth} not found; count=${await buttons.count()}`);
  await humanClickLocator(page, buttons.nth(nth));
  await humanIdlePause('long');
}

async function saveForm() {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  if (await saves.count() === 0) throw new Error('no enabled Zapisz');
  await humanClickLocator(page, saves.last());
  await humanIdlePause('long');
}

async function fillBySuffix(suffix, value) {
  const loc = page.locator(`textarea[name$="${suffix}"], input[name$="${suffix}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value).length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await humanFill(page, loc, v);
  await humanIdlePause('short');
  return `${suffix} ${v.length}/${max}`;
}

async function fillByName(name, value) {
  const loc = page.locator(`[name="${name}"]`).first();
  await loc.waitFor({ state: 'visible' });
  const max = Number(await loc.getAttribute('maxlength')) || String(value).length;
  let v = String(value || '');
  if (v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '');
  await humanFill(page, loc, v);
  await humanIdlePause('short');
  return `${name} ${v.length}/${max}`;
}

async function setAutoByName(name, search) {
  const inp = page.locator(`input[name="${name}"]`).first();
  await humanClickLocator(page, inp);
  await humanFill(page, inp, search);
  await humanIdlePause('deliberate');
  const opt = page.locator('[role="option"]').first();
  if (await opt.count() === 0) throw new Error(`no option for ${name}: ${search}`);
  const picked = (await opt.textContent())?.trim();
  await humanClickLocator(page, opt);
  await humanIdlePause('short');
  return picked;
}

async function pickFactors() {
  const picked = [];
  for (const label of [
    'wiodącej pozycji Unii',
    'pozytywnych skutków transgranicznych',
  ]) {
    const inp = page.locator('input[name$="rezultat_prac_br_spelnia_nastepujace_czynniki"]').first();
    await humanClickLocator(page, inp);
    await humanFill(page, inp, '');
    await humanIdlePause('deliberate');
    const opt = page.locator('[role="option"]').filter({ hasText: label }).first();
    if (await opt.count() === 0) {
      const seen = await page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).filter(Boolean));
      throw new Error(`factor option not found: ${label}; seen=${seen.join(' | ')}`);
    }
    await humanClickLocator(page, opt);
    picked.push(label);
    await humanIdlePause('short');
  }
  return picked;
}
  return { clickDodaj, saveForm, fillBySuffix, fillByName, setAutoByName, pickFactors };
}
