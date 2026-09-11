// The explicit modes of the 10.4 sync: listing what the act autocomplete offers, adding the
// OOŚ row alone, and syncing every vetted row. Each prints its result and exits.
import { humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { rowNeedles, staleNeedles, targets } from './source.mjs';

export async function runModes({ page, SECTION_URL, table, form }) {
  const { tableState, openRowByNeedle, deleteRowByNeedle, clickAdd } = table;
  const { fillTextLikeField, setLegalAct, saveRow, fillLegalActForm } = form;
if (process.env.DIAG_ADD) {
  await clickAdd();
  const input = page.locator('input[name="akt_prawny"]').first();
  await input.waitFor({ state: 'visible' });
  const searches = (process.env.DIAG_SEARCHES || 'Prawo ochrony środowiska|ustawa z dnia 27 kwietnia|ustawa OOŚ|ustawa z dnia 3 października|udostępnianiu informacji')
    .split('|')
    .filter(Boolean);
  const results = [];
  for (const search of searches) {
    await humanFill(page, input, search);
    await humanIdlePause('deliberate');
    const options = await page.evaluate(() => Array.from(document.querySelectorAll("[role='listbox'] [role='option'], [role='option']"))
      .map((o) => o.textContent.trim())
      .filter(Boolean)
      .slice(0, 30)); // allow-raw-playwright: read visible legal-act options only
    results.push({ search, options });
  }
  console.log(JSON.stringify({ diagAdd: results }, null, 2));
  process.exit(0);
}

if (process.env.ADD_OOS_ONLY) {
  const row = targets.find((candidate) => /udostępnianiu informacji|3 października 2008/i.test(candidate.act));
  if (!row) throw new Error('OOŚ row not found in markdown');
  console.log(JSON.stringify({ stage: 'start', row: { act: row.act, len: row.formJustificationLength } }));
  await clickAdd();
  console.log(JSON.stringify({ stage: 'opened' }));
  const picked = await setLegalAct(row);
  console.log(JSON.stringify({ stage: 'picked', picked }));
  const justFill = await fillTextLikeField((el) => {
    const name = el.name || '';
    return name === 'uzasadnienie' || name.endsWith('.uzasadnienie');
  }, row.formJustification);
  console.log(JSON.stringify({ stage: 'filled', justFill }));
  const formState = await page.evaluate(() => ({
    visibleFields: Array.from(document.querySelectorAll('input, textarea')).filter((el) => el.offsetParent !== null).map((el) => ({
      name: el.name || '',
      value: (el.value || '').slice(0, 160),
      len: (el.value || '').length,
      role: el.getAttribute('role') || '',
      invalid: el.getAttribute('aria-invalid') || '',
    })),
    saves: Array.from(document.querySelectorAll('button')).filter((button) => button.innerText.trim() === 'Zapisz').map((button) => ({
      disabled: button.disabled,
      visible: !!button.getClientRects().length,
    })),
    errors: Array.from(document.querySelectorAll('[aria-invalid="true"], .Mui-error')).map((el) => (el.getAttribute('name') || el.textContent || '').trim().slice(0, 160)).filter(Boolean).slice(0, 20),
  })); // allow-raw-playwright: read add-form state before save
  console.log(JSON.stringify({ stage: 'formState', formState }));
  const save = await saveRow();
  console.log(JSON.stringify({ stage: 'save', save }));
  await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: return to 10.4 table
  await humanIdlePause('long');
  const readback = await tableState();
  console.log(JSON.stringify({ stage: 'readback', readback }, null, 2));
  process.exit(0);
}

if (process.env.SYNC_ALL) {
  const before = await tableState();
  const deleted = [];
  for (const needles of staleNeedles) {
    deleted.push({ needles, ...(await deleteRowByNeedle(needles)) });
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: return to 10.4 table after delete attempt
    await humanIdlePause('long');
  }
  const startAt = Number(process.env.START_AT || 0);
  const syncTargets = targets.slice(startAt);
  const results = [];
  for (const row of syncTargets) {
    const current = await tableState();
    const text = JSON.stringify(current);
    const needles = rowNeedles(row);
    const alreadyPresent = needles.some((needle) => text.includes(needle));
    if (alreadyPresent) {
      await openRowByNeedle(needles);
      results.push({ act: row.act, action: 'edit', ...(await fillLegalActForm(row)) });
    } else {
      await clickAdd();
      results.push({ act: row.act, action: 'add', ...(await fillLegalActForm(row)) });
    }
    await page.goto(SECTION_URL, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: return to 10.4 table after row save
    await humanIdlePause('long');
  }
  const readback = await tableState();
  const allText = JSON.stringify(readback);
  console.log(JSON.stringify({
    expected: targets.map((row) => ({ act: row.act, formJustificationLength: row.formJustificationLength })),
    before,
    deleted,
    results,
    readback,
    foundCount: targets.filter((row) => rowNeedles(row).some((needle) => allText.includes(needle))).length,
    staleHits: {
      industrialDirective: /2010\/75/.test(allText),
      renewablesDirective: /2018\/2001/.test(allText),
      oos: /ustawa z dnia 3 października 2008|udostępnianiu informacji o środowisku/i.test(allText),
      bat: /\bBAT\b|najlepsz/i.test(allText),
      industrialEmissions: /emisji przemys/i.test(allText),
    },
  }, null, 2));
  process.exit(0);
}
}
