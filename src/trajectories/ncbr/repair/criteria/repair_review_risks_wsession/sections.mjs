// The 6.1, 9.2 and 4.1 repairs of repair_review_risks_wsession.mjs, bound to the page and the form helpers.
import { humanClickLocator } from '../../../../../../dist/human/mouse.js';
import { indicators92, management41, task5 } from './text.mjs';

export function riskRepairs({
  page,
  URL_41,
  URL_61,
  URL_92,
  saveVisibleForm,
  fillByName,
  fillBySuffix,
}) {
  async function openTask61(nr) {
    await page.goto(URL_61, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section 6.1 navigation
    const row = page
      .locator('table tbody tr')
      .filter({ has: page.locator(`td[title^="${nr}. " ]`) })
      .first();
    const btn = row
      .locator(
        'button[aria-label="overflow-options"]:not(:disabled):not([aria-disabled="true"])',
      )
      .first();
    await btn.waitFor({ state: 'visible' });
    await humanClickLocator(page, btn);
    await page
      .getByRole('menuitem', { name: 'Edytuj', exact: true })
      .filter({ visible: true })
      .first()
      .dispatchEvent('click'); // allow-raw-playwright: edit existing task row
    await page.waitForSelector('[name="nazwa_zadania"]');
  }

  async function repairTask5() {
    console.log('[6.1] repair task 5');
    await openTask61('5');
    const filled = [];
    filled.push(await fillByName('nazwa_zadania', task5.name));
    filled.push(await fillByName('zakres_planowanych_prac_br', task5.scope));
    filled.push(await fillByName('szczegolowy_opis_prac', task5.detail));

    const indexes = await page.evaluate(() =>
      [
        ...new Set(
          Array.from(
            document.querySelectorAll(
              'textarea[name^="kamienie_milowe_kolekcja["]',
            ),
          )
            .map((el) =>
              Number(
                (el.name.match(/kamienie_milowe_kolekcja\[(\d+)\]/) || [])[1],
              ),
            )
            .filter((n) => Number.isInteger(n)),
        ),
      ].sort((a, b) => a - b),
    ); // allow-raw-playwright: read nested milestone indexes
    for (const idx of indexes.slice(0, task5.milestones.length)) {
      const m = task5.milestones[idx];
      filled.push(
        await fillByName(
          `kamienie_milowe_kolekcja[${idx}].kamienie_milowe_nazwa`,
          m.name,
        ),
      );
      filled.push(
        await fillByName(
          `kamienie_milowe_kolekcja[${idx}].kamienie_milowe_parametry`,
          m.params,
        ),
      );
      filled.push(
        await fillByName(
          `kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_weryfikacji`,
          m.verify,
        ),
      );
      filled.push(
        await fillByName(
          `kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_wplywu`,
          m.impact,
        ),
      );
    }
    if (filled.some((field) => field.changed)) await saveVisibleForm();
    return filled;
  }

  async function openIndicator92(name) {
    await page.goto(URL_92, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section 9.2 navigation
    const row = page
      .locator('table tbody tr')
      .filter({ hasText: name })
      .first();
    const btn = row
      .locator(
        'button[aria-label="overflow-options"]:not(:disabled):not([aria-disabled="true"])',
      )
      .first();
    await btn.waitFor({ state: 'visible' });
    await humanClickLocator(page, btn);
    await page
      .getByRole('menuitem', { name: 'Edytuj', exact: true })
      .filter({ visible: true })
      .first()
      .dispatchEvent('click'); // allow-raw-playwright: edit existing indicator row
    await page.waitForSelector(
      'textarea[name$="opis_metodologii"], textarea[name$="opis_sposobu_weryfikacji"]',
    );
  }

  async function repairIndicators92() {
    const results = [];
    for (const ind of indicators92) {
      console.log(`[9.2] ${ind.name}`);
      await openIndicator92(ind.name);
      const filled = [];
      filled.push(await fillBySuffix('opis_metodologii', ind.methodology));
      filled.push(
        await fillBySuffix('opis_sposobu_weryfikacji', ind.verification),
      );
      const changed = filled.some((field) => field.changed);
      if (changed) await saveVisibleForm();
      results.push({
        name: ind.name,
        filled,
        save: changed ? 'save_clicked' : 'unchanged',
      });
    }
    return results;
  }

  async function repairManagement41() {
    console.log('[4.1] repair management text');
    await page.goto(URL_41, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section 4.1 navigation
    const filled = await fillBySuffix(
      'sposob_zarzadzania_projektem',
      management41,
    );
    if (filled.changed) await saveVisibleForm();
    return { ...filled, save: filled.changed ? 'save_clicked' : 'unchanged' };
  }

  async function readManagement41() {
    await page.goto(URL_41, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: section 4.1 read-only navigation
    const field = page
      .locator(
        'textarea[name$="sposob_zarzadzania_projektem"], input[name$="sposob_zarzadzania_projektem"]',
      )
      .filter({ visible: true })
      .first();
    await field.waitFor({ state: 'visible' });
    return await field.evaluate((el) => {
      const value = el?.value || '';
      return {
        url: location.href,
        len: value.length,
        hasKierownikBR: /Kierownik B\+R/i.test(value),
        hasLimitWord: /\blimit|\blimitem|\blimitu/i.test(value),
        suffix: value.slice(-320),
      };
    }); // allow-raw-playwright: read one section 4.1 textarea only
  }

  return {
    openTask61,
    repairTask5,
    openIndicator92,
    repairIndicators92,
    repairManagement41,
    readManagement41,
  };
}
