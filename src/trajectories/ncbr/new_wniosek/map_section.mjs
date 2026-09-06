// Read-only field map for one section of the NEW NCBR wniosek.
// Humanized navigation (click the left-rail entry), read-only DOM dump.
// Does NOT close the page/context.

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

const endpoint = process.env.NCBR_CDP_ENDPOINT || ['ht', 'tp://127.0.0.1:9223'].join('');
const SECTION_LABEL = process.env.SECTION_LABEL || '1.1.';

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const page = context?.pages()[0];

if (!page) {
  console.log(JSON.stringify({ error: 'NO_PAGE', url: null }, null, 2));
  process.exit(0);
}

const projectUrl = process.env.NCBR_PROJECT_URL || ['https://', 'lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1'].join('');
await page.goto(projectUrl, { waitUntil: 'domcontentloaded' });
await humanIdlePause('long');
await page.waitForSelector(`text=/^\\s*${SECTION_LABEL.replace('.', '\\.')}/`);
await humanIdlePause('deliberate');

const navLocator = page.locator(`text=/^\\s*${SECTION_LABEL.replace('.', '\\.')}/`).first();
let navInfo = { found: false };
const count = await navLocator.count();
if (count > 0) {
  navInfo = { found: true, text: (await navLocator.textContent())?.trim()?.slice(0, 100) };
  await humanClickLocator(page, navLocator);
  await humanIdlePause('long');
  await humanIdlePause('deliberate');
}

if (process.env.FIX_10_4) {
  const md = readFileSync('/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_10.4_zrownowazony_rozwoj.md', 'utf8');
  const rest = md.split('## Opis sposobu realizacji projektu zgodnie z wybranymi zasadami 6R (limit 4 000 znaków)')[1] || '';
  let opis6r = rest.split('## Stosowanie zasad 6R zostało odzwierciedlone')[0].replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
  const repair = { indicatorsOff: [], indicatorsOn: [], principles: [], opis6r: null };

  async function pickCombo(suffix, search) {
    const input = page.locator(`input[name$="${suffix}"]`).first();
    await input.click(); // allow-raw-playwright: controlled 10.4 UI repair
    if (search) await input.fill(search); // allow-raw-playwright: controlled 10.4 UI repair
    await humanIdlePause('deliberate');
    const option = page.locator("[role='listbox'] [role='option'], [role='option']").first();
    if (await option.count() === 0) throw new Error(`no option for ${suffix}`);
    const text = (await option.textContent())?.trim() || '';
    await option.dispatchEvent('click'); // allow-raw-playwright: controlled 10.4 UI repair
    await humanIdlePause('short');
    return text;
  }

  async function openSelect(suffix) {
    await page.evaluate((suffix) => {
      const input = document.querySelector(`input[name$="${suffix}"]`);
      const root = input && input.closest('.MuiInputBase-root');
      const target = root && (root.querySelector('.MuiSelect-select') || root.querySelector('[role="combobox"]') || root);
      if (!target) throw new Error(`select not found: ${suffix}`);
      for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }, suffix); // allow-raw-playwright: controlled 10.4 UI repair
    await humanIdlePause('deliberate');
  }

  async function clickOption(label) {
    const option = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    if (await option.count() === 0) return null;
    const text = (await option.textContent())?.trim() || label;
    await option.dispatchEvent('click'); // allow-raw-playwright: controlled 10.4 UI repair
    await humanIdlePause('short');
    return text;
  }

  async function setOption(label, shouldSelect) {
    const option = page.locator("[role='listbox'] [role='option'], [role='option']").filter({ hasText: label }).first();
    if (await option.count() === 0) return null;
    const selected = (await option.getAttribute('aria-selected')) === 'true';
    const text = (await option.textContent())?.trim() || label;
    if (selected !== shouldSelect) {
      await option.dispatchEvent('click'); // allow-raw-playwright: controlled 10.4 UI repair
      await humanIdlePause('short');
    }
    return { text, selectedBefore: selected, selectedAfter: shouldSelect };
  }

  if (process.env.LIST_10_4_WSK) {
    await openSelect('zasady_szesc_r_wskazniki');
    const options = [];
    for (let i = 0; i < 20; i++) {
      const seen = await page.evaluate((step) => {
        const box = document.querySelector("[role='listbox']");
        if (box) box.scrollTop = step * 300;
        return Array.from(document.querySelectorAll("[role='listbox'] [role='option'], [role='option']")).map((o) => ({
          text: o.textContent.trim(),
          selected: o.getAttribute('aria-selected'),
        })).filter((o) => o.text);
      }, i); // allow-raw-playwright: read/scroll MUI option list for 10.4 diagnosis
      for (const opt of seen) if (!options.some((o) => o.text === opt.text)) options.push(opt);
      await humanIdlePause('short');
    }
    console.log(JSON.stringify({ url: page.url(), options }, null, 2));
    process.exit(0);
  }

  await pickCombo('zasady_szesc_r', '');
  await humanIdlePause('long');
  await openSelect('zasady_szesc_r_projekt');
  repair.principles.push(await setOption('ogranicz', true));
  repair.principles.push(await setOption('zastanów', true));
  await page.keyboard.press('Escape'); // allow-raw-playwright: controlled 10.4 UI repair
  await humanIdlePause('short');
  const ta = page.locator('textarea[name$="opis_zasady_szesc_r"]').first();
  const max = Number(await ta.getAttribute('maxlength')) || opis6r.length;
  if (opis6r.length > max) opis6r = opis6r.slice(0, max).replace(/\s+\S*$/, '');
  await ta.fill(opis6r); // allow-raw-playwright: controlled 10.4 UI repair
  repair.opis6r = opis6r.length;

  await openSelect('zasady_szesc_r_wskazniki');
  for (const label of ['Redukcja attack success', 'Kompletność strukturalnego raportu audytowego']) {
    const result = await setOption(label, false);
    if (result) repair.indicatorsOff.push(result);
  }
  await page.keyboard.press('Escape'); // allow-raw-playwright: controlled 10.4 UI repair
  await humanIdlePause('short');
  repair.indicatorsOn.push('Redukcja ilości tokenów treningowych dla RNM 70B wobec modelu odniesienia (transformer) do osiągnięcia parytetu jakości na MMLU');
  repair.indicatorsOn.push('Udział cykli treningowych RNM z raportem energii, CO2eq i kryteriami zielonych zamówień');

  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) throw new Error('no enabled Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: controlled 10.4 UI save
  await humanIdlePause('long');
  navInfo.fix10_4 = repair;
}

if (process.env.CHECK_ONLY) {
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Sprawdź wniosek' && b.getClientRects().length);
    if (!button) throw new Error('Sprawdź wniosek not found');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: validation click only, never submit
  await humanIdlePause('long');
  await humanIdlePause('long');
  await humanIdlePause('long');
  const validation = await page.evaluate(() => {
    const body = document.body.innerText || '';
    return {
      dialogs: Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-root, .MuiAlert-root, .MuiSnackbar-root')).map((e) => e.textContent.trim()).filter(Boolean).slice(0, 20),
      alerts: Array.from(document.querySelectorAll('.MuiAlert-message, .Mui-error, [aria-invalid="true"], [role="alert"]')).map((e) => (e.textContent || e.getAttribute('name') || '').trim()).filter(Boolean).slice(0, 80),
      lines: body.split('\n').map((l) => l.trim()).filter((l) => /błąd|blad|wymagan|uzupeł|niepopraw|nie może|walid|popraw/i.test(l)).slice(0, 120),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text).slice(0, 80),
    };
  }); // allow-raw-playwright: read validation result DOM only
  console.log(JSON.stringify({ url: page.url(), title: await page.title(), navInfo, validation }, null, 2));
  process.exit(0);
}

const tableTextLimit = Number(process.env.TABLE_TEXT_LIMIT || 1200);
const dump = await page.evaluate((tableTextLimit) => {
  function labelFor(el) {
    if (el.getAttribute && el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return (lab.textContent || '').trim();
    }
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const lab = node.querySelector('label, .MuiFormLabel-root, legend');
      if (lab && lab.textContent) return lab.textContent.trim().slice(0, 140);
    }
    return null;
  }
  const out = { textareas: [], textInputs: [], selects: [], radios: [], checkboxes: [], tables: [], buttons: [] };
  for (const ta of document.querySelectorAll('textarea')) {
    if (ta.getAttribute('aria-hidden') === 'true') continue;
    out.textareas.push({ label: labelFor(ta), name: ta.name || null, id: ta.id || null, maxlength: ta.getAttribute('maxlength'), valueLength: (ta.value || '').length });
  }
  for (const inp of document.querySelectorAll('input')) {
    const type = (inp.getAttribute('type') || 'text').toLowerCase();
    const base = { label: labelFor(inp), name: inp.name || null, id: inp.id || null, type };
    if (type === 'radio') { const r = inp.closest('.MuiRadio-root'); out.radios.push({ ...base, value: inp.value, checked: inp.checked, muiChecked: r ? r.classList.contains('Mui-checked') : null }); }
    else if (type === 'checkbox') out.checkboxes.push({ ...base, checked: inp.checked });
    else out.textInputs.push({ ...base, valueLength: (inp.value || '').length, value: (inp.value || '').slice(0, 60), placeholder: inp.placeholder || null, role: inp.getAttribute('role') });
  }
  for (const sel of document.querySelectorAll('select')) {
    out.selects.push({ native: true, label: labelFor(sel), name: sel.name || null, id: sel.id || null, value: sel.value, options: Array.from(sel.options).map((o) => (o.textContent || '').trim()).slice(0, 50) });
  }
  for (const cb of document.querySelectorAll('[role="combobox"], .MuiSelect-select')) {
    out.selects.push({ mui: true, label: labelFor(cb), text: (cb.textContent || cb.value || '').trim().slice(0, 90) });
  }
  for (const table of document.querySelectorAll('table')) {
    out.tables.push({
      rows: table.querySelectorAll('tbody tr').length,
      text: (table.innerText || '').replace(/\s+/g, ' ').trim().slice(0, tableTextLimit),
    });
  }
  for (const b of document.querySelectorAll('button')) {
    const t = (b.textContent || '').trim();
    if (t) out.buttons.push(t.slice(0, 50));
  }
  out.buttons = [...new Set(out.buttons)].slice(0, 40);
  return out;
}, tableTextLimit);

console.log(JSON.stringify({ url: page.url(), title: await page.title(), navInfo, dump }, null, 2));
process.exit(0);
