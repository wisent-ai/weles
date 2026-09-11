// The diagnostic modes of the 2.2 collections fix. Each one prints what it saw and exits;
// none of them writes to the application.
import { humanClickLocator, humanIdlePause } from '../../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../../dist/human/keyboard.js';

export async function runDiagnostics({ page, clickDodaj, pickFactors }) {
if (process.env.DIAG_DODAJ) {
  await clickDodaj(Number(process.env.DIAG_DODAJ) || 0);
  const out = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      return { tag: el.tagName, name: el.name || null, type: el.type || null, role: el.getAttribute('role'), max: el.getAttribute('maxlength'), value: (el.value || '').slice(0, 80), label };
    }).filter((f) => f.name || f.label),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean),
  }));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (process.env.DIAG_FACTOR_DODAJ) {
  const picked = await pickFactors();
  await clickDodaj(1);
  const out = await page.evaluate(() => ({
    picked: Array.from(document.querySelectorAll('.MuiChip-label')).map((e) => e.textContent.trim()),
    fields: Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null;
      return { tag: el.tagName, name: el.name || null, type: el.type || null, role: el.getAttribute('role'), max: el.getAttribute('maxlength'), value: (el.value || '').slice(0, 80), label };
    }).filter((f) => f.name || f.label),
    buttons: Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim()).filter(Boolean),
  }));
  console.log(JSON.stringify({ picked, out }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_FACTORS) {
  const inp = page.locator('input[name$="rezultat_prac_br_spelnia_nastepujace_czynniki"]').first();
  await humanClickLocator(page, inp);
  await humanIdlePause('deliberate');
  const options = await page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).filter(Boolean));
  console.log(JSON.stringify({ options }, null, 2));
  process.exit(0);
}

if (process.env.CLEAR_POW) {
  const out = await page.evaluate(() => {
    const el = document.querySelector('textarea[name$="innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci"]');
    const before = el ? el.value : null;
    if (el && before) {
      el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz');
    return {
      beforeLen: before?.length ?? null,
      afterLen: el ? el.value.length : null,
      saves: saves.map((b) => ({ disabled: b.disabled, text: b.innerText.trim(), visible: b.getClientRects().length > 0 })),
      errors: Array.from(document.querySelectorAll('[aria-invalid="true"], .Mui-error')).map((e) => (e.getAttribute('name') || e.textContent || '').trim().slice(0, 100)).filter(Boolean).slice(0, 20),
    };
  }); // allow-raw-playwright: clear forbidden field and inspect save state
  await humanIdlePause('deliberate');
  let saveResult = 'not-clicked';
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const clicked = await saves.count() > 0;
  if (clicked) await humanClickLocator(page, saves.last());
  if (clicked) { saveResult = 'clicked'; await humanIdlePause('long'); }
  const readback = await page.evaluate(() => ({
    powLen: document.querySelector('textarea[name$="innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci"]')?.value.length ?? null,
    saves: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
  })); // allow-raw-playwright: read back field state
  console.log(JSON.stringify({ out, saveResult, readback }, null, 2));
  process.exit(0);
}

if (process.env.CLEAR_POW_KEYS) {
  const loc = page.locator('textarea[name$="innowacja_produktowa_powiazanie_rezultatu_prac_br_z_lancuchem_wartosci"]').first();
  const before = await loc.inputValue();
  await humanClickLocator(page, loc);
  await loc.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); // allow-raw-playwright: select current value
  await loc.press('Backspace'); // allow-raw-playwright: remove current value through field keyboard handler
  await loc.press('Tab'); // allow-raw-playwright: blur so form validation runs
  await humanIdlePause('deliberate');
  const after = await loc.inputValue();
  const savesBefore = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled));
  let saveResult = 'not-clicked';
  const saves = page.getByRole('button', { name: 'Zapisz', exact: true }).filter({ visible: true });
  const clicked = await saves.count() > 0;
  if (clicked) await humanClickLocator(page, saves.last());
  if (clicked) { saveResult = 'clicked'; await humanIdlePause('long'); }
  console.log(JSON.stringify({ beforeLen: before.length, afterLen: after.length, savesBefore, saveResult }, null, 2));
  process.exit(0);
}

if (process.env.DIAG_SET_KIND) {
  const inp = page.locator('input[name$="rodzaj_innowacji"]').first();
  await humanClickLocator(page, inp);
  await humanFill(page, inp, 'Innowacja produktowa');
  await humanIdlePause('deliberate');
  await inp.press('ArrowDown'); // allow-raw-playwright: highlight option
  await inp.press('Enter'); // allow-raw-playwright: accept highlighted option
  await humanIdlePause('deliberate');
  const out = await page.evaluate(() => ({
    kind: Array.from(document.querySelectorAll('input')).find((i) => i.name.endsWith('rodzaj_innowacji'))?.value || '',
    productVisible: Boolean(document.querySelector('input[name$="innowacja_produktowa_nazwa"]')),
    saves: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
  }));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
}
