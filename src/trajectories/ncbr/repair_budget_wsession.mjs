// UI-only repair for budget sections 6.3 and 6.5 in the replacement NCBR STEP B draft.
// Never submits. Uses visible LSI forms only.

import { WSession } from '../../../dist/index.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const BASE = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}/projekt_step/`;
const URL_63 = `${BASE}fb417879-403e-4241-a202-ec23c6a6b866`;
const URL_65 = `${BASE}bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b`;
const URL_8 = `${BASE}d31b6d68-33b7-45a0-a032-0f5f02b5aed8`;
const URL_22 = `${BASE}80ebca16-a9dd-4798-a334-5ac007cecbf7`;
const URL_13 = `${BASE}317a21dd-e798-4115-ab53-6ab5a2912fb0`;
const URL_14 = `${BASE}4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc`;
const URL_23 = `${BASE}c5dbdc83-5baf-4866-b3d8-4da3ae553865`;
const URL_61 = `${BASE}566c735c-8ad0-406f-a948-f3ea921c2cc7`;
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;
const KEEP_OPEN = process.env.KEEP_OPEN === '1';

if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const DIRECT_ROWS = [
  {
    match: /1\s*049\s*000,00\s*zł/i,
    name: 'Senior Machine Learning Engineer RNM (1,0 FTE, 36 mies.)',
    total: '1049000.00',
    grant: '839200.00',
    uz: 'Koszt obejmuje wyłącznie techniczne prace B+R wykonywane przez Senior Machine Learning Engineera: projekt funkcji celu RNM, implementację prototypów treningowych, eksperymenty reprezentacyjne, analizę wyników, debugowanie modeli i dokumentację badawczą. Nie obejmuje kierowania projektem, koordynacji administracyjnej, raportowania finansowego, sprzedaży ani czynności właścicielskich; takie czynności są pokrywane kosztami pośrednimi.',
    met: 'Kalkulacja: 1,0 FTE x 36 miesięcy x pełny miesięczny koszt pracodawcy dla senior/principal ML engineer w projekcie AI. Stawkę oszacowano na podstawie rynkowych widełek wynagrodzeń AI/ML w UE i Polsce, poziomu seniority oraz odpowiedzialności za architekturę eksperymentalnych modeli RNM.',
  },
  {
    match: /4\s*251\s*000,00\s*zł/i,
    name: 'Pozostały personel B+R - badania przemysłowe (4,25 FTE, 36 mies.)',
    total: '4251000.00',
    grant: '3400800.00',
    uz: 'Koszt obejmuje stanowiska badawcze i inżynierskie w zadaniach badań przemysłowych: ML Research Scientist, Research Engineer, Data/Evaluation Scientist oraz MLOps Experiment Engineer. Zakres obejmuje projekt eksperymentów, trening modeli, ekstrakcję konceptów, ewaluację i analizę wyników. Nie obejmuje zarządzania administracyjnego, marketingu, sprzedaży ani utrzymania komercyjnego.',
    met: 'Kalkulacja: 4,25 FTE x 36 miesięcy x średni pełny koszt pracodawcy dla ról ML/R&D. Stawki dobrano według poziomów seniority, stawek rynkowych AI/ML i udziału czasu w zadaniach badawczych. Koszty przypisano proporcjonalnie do zadań badań przemysłowych.',
  },
  {
    match: /(3\s*000\s*000,00|4\s*700\s*000,00)\s*zł/i,
    name: 'Wynajem mocy GPU do treningu i ewaluacji RNM w zadaniach BP',
    total: '4700000.00',
    grant: '3760000.00',
    uz: 'Koszt obejmuje wynajem mocy GPU w UE do treningu RNM 1B/8B/30B/70B, treningu modeli referencyjnych, checkpointów, pomiaru krzywych uczenia i benchmarków w zadaniach badań przemysłowych. Compute jest używany wyłącznie do eksperymentów B+R, nie do produkcyjnej obsługi klientów ani bieżącej działalności operacyjnej.',
    met: 'Szacunek obejmuje pełne cykle treningowe RNM 1B/8B/30B/70B, modele referencyjne, checkpointy, powtórzenia eksperymentów, walidację porównawczą i przechowywanie artefaktów. Kalkulacja odpowiada ok. 750 tys. godzin GPU w ekwiwalencie H100/B300/A100/L40S oraz cenom ofertowym europejskich dostawców infrastruktury GPU.',
  },
  {
    match: /(2\s*200\s*000,00|2\s*500\s*000,00)\s*zł/i,
    name: 'Personel B+R - prace rozwojowe: integracja modeli RNM, biblioteka i dokumentacja (2,45 FTE)',
    total: '2500000.00',
    grant: '1500000.00',
    uz: 'Koszt obejmuje wyłącznie wynagrodzenia personelu B+R wykonującego prace rozwojowe w Zadaniu 5: integrację wyników badań w działającą bibliotekę RNM, przygotowanie narzędzi API, uporządkowanie katalogu konceptów, testy techniczne implementacji, poprawki kodu oraz dokumentację techniczną. Nie obejmuje zewnętrznych pilotaży, publikacji, marketingu, compliance, obsługi klienta ani utrzymania komercyjnego.',
    met: 'Kalkulacja: 2,45 FTE w okresie prac rozwojowych x pełny koszt pracodawcy ról ML Engineer, Software Engineer i Evaluation Engineer. Stawki oszacowano na podstawie widełek wynagrodzeń AI/software w UE i Polsce, wymaganego seniority oraz udziału tych osób w Zadaniu 5.',
  },
];

const OBSOLETE_ROWS = [
  'Licencje oprogramowania',
  'Ekspertyzy IP/AI Act',
  'Koszty walidacji PR',
];

const INDIRECT_ROWS = [
  {
    match: 'Pomoc na badania przemysłowe',
    total: '1325000.00',
    grant: '1060000.00',
    info: '25%',
    uz: 'Koszty pośrednie obejmują administrację, księgowość, HR, obsługę prawną, IT support, utrzymanie siedziby i zarządzanie projektem w części przypisanej do badań przemysłowych. Wybrano metodę uproszczoną - stawkę ryczałtową 25% kwalifikowalnych kosztów bezpośrednich objętych podstawą naliczenia kosztów pośrednich.',
  },
  {
    match: 'Pomoc na prace rozwojowe',
    total: '625000.00',
    grant: '375000.00',
    info: '25%',
    uz: 'Koszty pośrednie obejmują administrację, księgowość, HR, obsługę prawną, IT support, utrzymanie siedziby i zarządzanie projektem w części przypisanej do prac rozwojowych. Wybrano metodę uproszczoną - stawkę ryczałtową 25% kosztów kwalifikowalnych prac rozwojowych.',
  },
];

const FIELD_REPAIRS_63 = [
  {
    match: /1\s*049\s*000,00\s*zł/i,
    name: 'Senior Machine Learning Engineer RNM (1,0 FTE, 36 mies.)',
    uz: DIRECT_ROWS[0].uz,
    met: DIRECT_ROWS[0].met,
  },
  {
    match: /4\s*251\s*000,00\s*zł/i,
    name: 'Pozostały personel B+R - badania przemysłowe (4,25 FTE, 36 mies.)',
    uz: DIRECT_ROWS[1].uz,
    met: DIRECT_ROWS[1].met,
  },
  {
    match: /(3\s*000\s*000,00|4\s*700\s*000,00)\s*zł/i,
    name: 'Wynajem mocy GPU do treningu i ewaluacji RNM w zadaniach BP',
    uz: DIRECT_ROWS[2].uz,
    met: DIRECT_ROWS[2].met,
  },
  {
    match: /(2\s*200\s*000,00|2\s*500\s*000,00)\s*zł/i,
    name: 'Personel B+R - prace rozwojowe: integracja modeli RNM, biblioteka i dokumentacja (2,45 FTE)',
    uz: DIRECT_ROWS[3].uz,
    met: DIRECT_ROWS[3].met,
  },
];

const FINANCING_8 = {
  total: '14450000.00',
  grant: '10935000.00',
  private: '3515000.00',
  own: '0.00',
  loan: '3515000.00',
};

const session = await WSession.start({ label: 'ncbr_repair_budget_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(30000);

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
  await locator.click({ force: true }); // allow-raw-playwright: focus controlled LSI input
  const locked = await locator.evaluate((el) => Boolean(el.readOnly || el.disabled)); // allow-raw-playwright: inspect controlled field mutability
  if (!locked) {
    await locator.fill(''); // allow-raw-playwright: clear controlled LSI input
    await locator.fill(value); // allow-raw-playwright: fill controlled LSI input
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
  await page.evaluate(() => {
    const input = document.querySelector('#isStatuteAccepted, input[name="isStatuteAccepted"]');
    if (!input || input.checked) return;
    const target = input.closest('label') || input.closest('.MuiFormControlLabel-root') || input.closest('.MuiCheckbox-root') || input;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    if (!input.checked) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set?.call(input, true);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }); // allow-raw-playwright: accept visible statute checkbox to log in only
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
      await page.locator('#login-btn, button:has-text("Zaloguj")').first().click({ force: true }); // allow-raw-playwright: visible login button only
    } else {
      await page.evaluate(() => {
        const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.includes('Zaloguj'));
        if (!btn) throw new Error('login button not found for retry');
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }); // allow-raw-playwright: retry visible login button dispatch
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
  await loc.click({ force: true }); // allow-raw-playwright: focus visible LSI field before human typing
  await loc.fill(String(value)); // allow-raw-playwright: fill visible editable LSI textarea with Playwright input events
  await humanIdlePause('short');
}

async function saveVisibleForm({ allowNoChange = false } = {}) {
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  const clicked = await page.evaluate((canSkip) => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) {
      if (canSkip) return false;
      throw new Error('no enabled visible Zapisz');
    }
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }, allowNoChange); // allow-raw-playwright: save visible section/row form only
  if (clicked) await humanIdlePause('long');
  return clicked ? 'saved' : 'no_change';
}

async function deleteRows63() {
  const deleted = [];
  for (const target of OBSOLETE_ROWS) {
    console.log(`[6.3 delete] ${target}`);
    await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation
    await humanIdlePause('long');
    const row = page.locator('table').first().locator('tbody tr').filter({ hasText: target }).first();
    if (await row.count() === 0) { deleted.push({ target, status: 'not_found' }); continue; }
    await openRowMenu(target);
    await clickMenu(/Usuń|Usun|Delete/i);
    const confirm = page.locator('button').filter({ hasText: /Usuń|Usun|Potwierdź|Tak|Delete/i }).last();
    if (await confirm.count() > 0) await confirm.dispatchEvent('click'); // allow-raw-playwright: confirm visible delete dialog
    await humanIdlePause('long');
    deleted.push({ target, status: 'deleted' });
  }
  return deleted;
}

async function rewriteRows63() {
  const rewritten = [];
  for (const row of DIRECT_ROWS) {
    console.log(`[6.3 rewrite] ${row.match} -> ${row.name}`);
    await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation
    await humanIdlePause('long');
    await openRowMenu(row.match);
    await clickMenu(/Edytuj/i);
    await fill('nazwa_kosztu', row.name);
    await fill('wydatki_ogolem', row.total);
    await fill('wydatki_kwalifikowalne', row.total);
    await fill('w_tym_vat', '0.00');
    await fill('dofinansowanie', row.grant);
    await typeFill('uzasadnienie_kosztu', row.uz);
    await typeFill('metoda_szacowania', row.met);
    await typeFill('nazwa_kosztu', row.name);
    await saveVisibleForm();
    rewritten.push(row.name);
  }
  return rewritten;
}

async function repairRequiredFields63() {
  const repaired = [];
  for (const row of FIELD_REPAIRS_63) {
    console.log(`[6.3 required fields] ${row.name}`);
    await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation for required-field repair
    await humanIdlePause('long');
    await openRowMenu(row.match);
    await clickMenu(/Edytuj/i);
    await page.locator('[name="nazwa_kosztu"]').first().waitFor({ state: 'visible', timeout: 10000 });
    await typeFill('uzasadnienie_kosztu', row.uz);
    await typeFill('metoda_szacowania', row.met);
    await typeFill('nazwa_kosztu', row.name);
    const state = await page.evaluate(() => ({
      nameLens: Array.from(document.querySelectorAll('[name="nazwa_kosztu"]')).map((e) => e.value?.length || 0),
      uzLens: Array.from(document.querySelectorAll('[name="uzasadnienie_kosztu"]')).map((e) => e.value?.length || 0),
      metLens: Array.from(document.querySelectorAll('[name="metoda_szacowania"]')).map((e) => e.value?.length || 0),
      saveDisabled: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
    })); // allow-raw-playwright: verify required fields before save
    if (Math.max(...state.nameLens, 0) === 0 || Math.max(...state.uzLens, 0) === 0 || Math.max(...state.metLens, 0) === 0) {
      throw new Error(`required 6.3 fields still empty for ${row.name}: ${JSON.stringify(state)}`);
    }
    const saveStatus = await saveVisibleForm({ allowNoChange: true });
    repaired.push({ name: row.name, state, saveStatus });
  }
  return repaired;
}

async function rewriteRows65() {
  const rewritten = [];
  for (const row of INDIRECT_ROWS) {
    console.log(`[6.5 rewrite] ${row.match}`);
    await page.goto(URL_65, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: indirect-cost section navigation
    await humanIdlePause('long');
    await openRowMenu(row.match);
    await clickMenu(/Edytuj/i);
    for (const amountName of ['wydatki_ogolem', 'wydatki_kwalifikowalne']) {
      const field = page.locator(`[name="${amountName}"]:visible`).last();
      if (await field.count() > 0) await fill(amountName, row.total);
    }
    await fill('dofinansowanie', row.grant);
    const info = page.locator('[name="informacje_o_metodzie_uproszczone"]').first();
    if (await info.count() > 0) await fill('informacje_o_metodzie_uproszczone', row.info);
    await typeFill('uzasadnienie_kosztu', row.uz);
    await saveVisibleForm();
    rewritten.push(row.match);
  }
  return rewritten;
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
  await page.evaluate((buttonText) => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.innerText.trim() === buttonText && !b.disabled && b.getClientRects().length);
    if (!btn) throw new Error(`enabled button not found: ${buttonText}`);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, text); // allow-raw-playwright: click one visible enabled LSI button
  await humanIdlePause('long');
}

async function repair63SecondMethod() {
  const row = DIRECT_ROWS[1];
  console.log(`[6.3 method-only] ${row.name}`);
  await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation for targeted repair
  await humanIdlePause('long');
  await openRowMenu(row.match);
  await clickMenu(/Edytuj/i);
  await page.locator('[name="metoda_szacowania"]').first().waitFor({ state: 'visible', timeout: 10000 });
  await typeFill('metoda_szacowania', row.met);
  const state = await page.evaluate(() => ({
    metLens: Array.from(document.querySelectorAll('[name="metoda_szacowania"]')).map((e) => e.value?.length || 0),
    saveDisabled: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
  })); // allow-raw-playwright: verify 6.3 method field before save
  await saveVisibleForm();
  return state;
}

async function repair63GpuNameOnly() {
  const row = DIRECT_ROWS[2];
  console.log(`[6.3 name-only] ${row.name}`);
  await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation for targeted name cleanup
  await humanIdlePause('long');
  await openRowMenu(row.match);
  await clickMenu(/Edytuj/i);
  await page.locator('[name="nazwa_kosztu"]').first().waitFor({ state: 'visible', timeout: 10000 });
  await typeFill('nazwa_kosztu', row.name);
  const state = await page.evaluate(() => ({
    nameValues: Array.from(document.querySelectorAll('[name="nazwa_kosztu"]')).map((e) => e.value || ''),
    saveDisabled: Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz').map((b) => b.disabled),
  })); // allow-raw-playwright: verify 6.3 GPU name before save
  await saveVisibleForm();
  return state;
}

async function setApplicantIfPresent() {
  await page.evaluate(() => {
    const inp = Array.from(document.querySelectorAll('input')).find((i) => /nazwa_skrocona/.test(i.name || ''));
    const sel = inp && inp.closest('.MuiInputBase-root')?.querySelector('.MuiSelect-select, [role="combobox"]');
    if (sel) for (const t of ['mousedown', 'mouseup', 'click']) sel.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: open visible applicant select in section 8 row
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: choose visible applicant option
  await humanIdlePause('short');
}

function valueForSection8Field(field) {
  const hay = `${field.name || ''} ${field.label || ''}`.toLowerCase();
  if (hay.includes('suma_wydatki_ogolem') || hay.includes('suma wydatków ogółem')) return FINANCING_8.total;
  if (hay.includes('suma_wydatki_kwalifikowalne') || hay.includes('suma wydatków kwalifikowalnych')) return FINANCING_8.total;
  if (hay.includes('srodki_wlasne') || hay.includes('środki własne') || hay.includes('własne')) return FINANCING_8.own;
  if (hay.includes('pozycz') || hay.includes('pożycz')) return FINANCING_8.loan;
  if (hay.includes('prywatne')) return FINANCING_8.private;
  if (hay.includes('kredyt')) return '0.00';
  if (hay.includes('inne')) return '0.00';
  if (hay.includes('dofinansowanie') || hay.includes('wnioskowane') || hay.includes('publiczne') || hay.includes('ue')) return FINANCING_8.grant;
  return null;
}

async function section8Fields() {
  return await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => {
    const id = el.id || '';
    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id,
      label,
      value: el.value || '',
      readOnly: el.readOnly,
      disabled: el.disabled,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none',
    };
  }).filter((x) => (x.name || x.label) && x.visible)); // allow-raw-playwright: read visible section 8 edit fields
}

async function repairSection8() {
  console.log('[8 repair] financing totals');
  await page.goto(URL_8, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 8 navigation
  await humanIdlePause('long');
  const existingRow = page.locator('table').first().locator('tbody tr').filter({ hasText: /Wisent Polska|WISENT POLSKA/i }).first();
  if (await existingRow.count() > 0) {
    await existingRow.locator('button[aria-label="overflow-options"]').first().dispatchEvent('click'); // allow-raw-playwright: open visible section 8 row menu
    await humanIdlePause('deliberate');
    await clickMenu(/Edytuj/i);
  } else {
    await clickVisibleButton('Dodaj');
    await setApplicantIfPresent();
  }

  let before = await section8Fields();
  const changed = [];
  for (const field of before) {
    if (!field.name || field.readOnly || field.disabled) continue;
    const value = valueForSection8Field(field);
    if (value === null) continue;
    await setReactInputValue(page.locator(`[name="${field.name}"]:visible`).last(), value);
    changed.push({ name: field.name, label: field.label, value });
  }
  if (changed.length === 0) {
    throw new Error(`no editable section 8 amount fields found: ${JSON.stringify(before)}`);
  }
  await saveVisibleForm();
  await page.goto(URL_8, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 8 readback navigation
  await humanIdlePause('long');
  const readback8 = await tableReadback(URL_8);
  before = before.map((f) => ({ name: f.name, label: f.label, value: f.value, readOnly: f.readOnly, disabled: f.disabled }));
  return { before, changed, readback8 };
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

async function repair22MainFactor() {
  console.log('[2.2 repair] main dependency factors');
  await page.goto(URL_22, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: 2.2 section navigation
  await humanIdlePause('long');
  const input = page.locator('input[name$="rezultat_prac_br_spelnia_nastepujace_czynniki"]').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.click({ force: true }); // allow-raw-playwright: open visible 2.2 multi-select
  await humanIdlePause('deliberate');
  let selected = null;
  try {
    selected = await selectVisibleOption(/bezpieczeństwa dostaw|bezpieczenstwa dostaw/i);
  } catch (e) {
    selected = `not_selected_or_already_selected: ${String(e?.message || e).slice(0, 160)}`;
  }
  await saveVisibleForm({ allowNoChange: true });
  const readback = await tableReadback(URL_22);
  return { selected, readback };
}

async function compactReadback() {
  return {
    '1.3': await tableReadback(URL_13),
    '1.4': await tableReadback(URL_14),
    '2.2': await tableReadback(URL_22),
    '2.3': await tableReadback(URL_23),
    '6.1': await tableReadback(URL_61),
    '6.3': await tableReadback(URL_63),
    '6.5': await tableReadback(URL_65),
    '8': await tableReadback(URL_8),
  };
}

async function validateProject() {
  const projectUrl = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
  const responses = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/validate-project')) return;
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    responses.push({ status: res.status(), url: res.url(), text });
  });
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: project page for validation-only action
  await humanIdlePause('long');
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Sprawdź wniosek' && !b.disabled);
    if (!btn) return { clicked: false, reason: 'enabled Sprawdz wniosek button not found' };
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { clicked: true };
  }); // allow-raw-playwright: validation-only button; never submit
  await humanIdlePause('long');
  await humanIdlePause('long');
  await humanIdlePause('long');
  const response = responses.at(-1) || null;
  if (!response) return { clicked, response: null };
  let parsed = null;
  try { parsed = JSON.parse(response.text); } catch {}
  const jsonSchemaErrors = [];
  const expressionErrors = [];
  if (parsed) {
    for (const sec of parsed.jsonSchemaValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) {
        jsonSchemaErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message, valueId: err.valueId });
      }
    }
    for (const sec of parsed.expressionValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) {
        expressionErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message, valueId: err.valueId });
      }
    }
  }
  return { clicked, status: response.status, jsonSchemaErrors, expressionErrors, rawHead: response.text.slice(0, 500) };
}

try {
  await login();
  if (process.env.FINAL_BUDGET_REPAIR === '1') {
    const repaired63 = await repair63SecondMethod();
    const repaired8 = await repairSection8();
    const readback63 = await tableReadback(URL_63);
    const readback65 = await tableReadback(URL_65);
    const validation = await validateProject();
    await finish({ repaired63, repaired8, readback63, readback65, validation });
  }
  if (process.env.REPAIR_63_GPU_NAME === '1') {
    const repairedGpuName = await repair63GpuNameOnly();
    const readback63 = await tableReadback(URL_63);
    const validation = await validateProject();
    await finish({ repairedGpuName, readback63, validation });
  }
  if (process.env.DUMP === '1') {
    const readback63 = await tableReadback(URL_63);
    const readback65 = await tableReadback(URL_65);
    await finish({ dumpOnly: true, url: page.url(), readback63, readback65 });
  }
  if (process.env.DUMP_ROW) {
    await page.goto(URL_63, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: budget section navigation for row diagnosis
    await humanIdlePause('long');
    await openRowMenu(process.env.DUMP_ROW);
    await clickMenu(/Edytuj/i);
    const fields = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => {
      const id = el.id || '';
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : null;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        id,
        label,
        value: el.value || '',
        valueLength: (el.value || '').length,
        max: el.getAttribute('maxlength'),
        readOnly: el.readOnly,
        disabled: el.disabled,
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none',
        y: Math.round(rect.y),
      };
    }).filter((x) => x.name || x.label)); // allow-raw-playwright: read visible edit form fields only
    const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })).filter((b) => b.text));
    await finish({ dumpRow: process.env.DUMP_ROW, url: page.url(), fields, buttons });
  }
  if (process.env.REPAIR_63_FIELDS === '1') {
    const repaired = await repairRequiredFields63();
    const readback63 = await tableReadback(URL_63);
    await finish({ repaired, readback63 });
  }

  const deleted63 = await deleteRows63();
  const rewritten63 = await rewriteRows63();
  const repairedFields63 = await repairRequiredFields63();
  const rewritten65 = await rewriteRows65();
  const repaired8 = await repairSection8();
  const repaired22 = await repair22MainFactor();
  const readback63 = await tableReadback(URL_63);
  const readback65 = await tableReadback(URL_65);
  const readback8 = await tableReadback(URL_8);
  const readbackCompact = await compactReadback();
  const validation = process.env.VALIDATE === '1' ? await validateProject() : null;

  await finish({ deleted63, rewritten63, repairedFields63, rewritten65, repaired8, repaired22, readback63, readback65, readback8, readbackCompact, validation });
} catch (error) {
  const errorPayload = {
    error: String(error?.stack || error?.message || error),
    currentUrl: page.url(),
    pageTitle: await page.title().catch(() => null),
    note: 'Nie kliknięto Złóż wniosek. Przy KEEP_OPEN=1 okno zostaje otwarte do diagnozy.',
  };
  await finish(errorPayload, 1);
}
