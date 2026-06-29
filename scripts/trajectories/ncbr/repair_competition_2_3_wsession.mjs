// UI-only repair for 1.4 competitors and 2.3 competition/parameter tables.
// Adds only missing rows by reading visible LSI table text first. Never submits.

import { readFileSync, writeFileSync } from 'node:fs';
import { WSession } from '../../../dist/index.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const URLS = {
  '1.4': `${BASE}4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc`,
  '2.3': `${BASE}c5dbdc83-5baf-4866-b3d8-4da3ae553865`,
};
const OUT = process.env.OUT || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/competition_2_3_repair_evidence_20260624.json';
const SOURCE_23 = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';

const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;
if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const competitors14 = [
  { name: 'Synerise S.A.', nip: '6793093292', desc: 'Synerise S.A. jest polskim konkurentem w obszarze zastosowań sztucznej inteligencji dla przedsiębiorstw, w szczególności analizy danych behawioralnych, personalizacji, predykcji zachowań użytkowników i automatyzacji decyzji biznesowych. Firma rozwija platformę AI przetwarzającą sygnały behawioralne w czasie rzeczywistym oraz rozwiązania oparte na modelach predykcyjnych i rekomendacyjnych. Konkurencja wobec Wisent dotyczy rynku europejskich odbiorców technologii AI dla biznesu oraz pozycji krajowego dostawcy zaawansowanego oprogramowania AI. Różnica polega na tym, że Synerise koncentruje się na warstwie zastosowań biznesowych i danych behawioralnych, natomiast projekt Wisent dotyczy bazowej architektury modeli generatywnych RNM, w której sterowalność i audytowalność wynikają z konstrukcji reprezentacji wewnętrznych modelu.' },
  { name: 'Mistral AI', nip: '0000000000', desc: 'Mistral AI jest europejskim konkurentem w obszarze dużych modeli językowych, modeli otwartych wag i rozwiązań AI dla przedsiębiorstw. Firma rozwija klasyczne modele transformerowe oraz narzędzia wdrażania modeli i agentów AI, konkurując o tych samych europejskich odbiorców technologii generatywnej. Przewagą Mistral jest skala finansowania, rozpoznawalność i istniejąca dystrybucja rynkowa. Przewaga Wisent polega na innym poziomie innowacji: RNM nie są kolejnym transformerem, lecz architekturą projektowaną tak, aby kompetencje, zachowania i polityki bezpieczeństwa były zapisane jako stabilne reprezentacje możliwe do diagnozy i sterowania. Wisent oferuje możliwość modyfikacji zachowania modelu bez ponownego trenowania całej architektury, większą audytowalność i lepsze dopasowanie do wymogów regulowanych sektorów UE.' },
  { name: 'Goodfire AI', nip: '0000000000', desc: 'Goodfire AI jest jednym z najbliższych konkurentów technologicznych Wisent. Działa w obszarze interpretowalności i inżynierii reprezentacji modeli AI, rozwijając narzędzia pozwalające rozumieć i projektować zachowanie zaawansowanych modeli przez analizę ich reprezentacji wewnętrznych. Konkurencja dotyczy warstwy kontroli, diagnostyki i bezpieczeństwa modeli. Przewagą Goodfire jest silne pozycjonowanie w interpretowalności i koncentracja na narzędziach dla zaawansowanych systemów AI. Przewaga Wisent polega na tym, że projekt RNM nie ogranicza się do analizy lub sterowania istniejącymi modelami po treningu, lecz rozwija architekturę, w której reprezentacje są stabilizowane i separowane już w czasie treningu. Audytowalność i możliwość modyfikacji zachowania modelu stają się cechą modelu, nie wyłącznie zewnętrznym narzędziem diagnostycznym.' },
  { name: 'Anthropic', nip: '0000000000', desc: 'Anthropic jest jednym z głównych konkurentów Wisent w segmencie bezpiecznych modeli generatywnych dla przedsiębiorstw. Firma rozwija rodzinę modeli Claude i pozycjonuje się jako podmiot budujący niezawodne oraz sterowalne systemy AI. Podejście Constitutional AI kształtuje zachowanie modelu przez zestaw zasad używanych w procesie treningu i dostrajania, co stanowi konkurencyjne rozwiązanie wobec potrzeby kontroli zachowania modeli. Przewagą Anthropic jest marka, jakość modeli i zaufanie klientów enterprise. Przewaga Wisent polega na kontroli na poziomie geometrii reprezentacji wewnętrznych, nie wyłącznie przez reguły, polityki lub zamknięty proces dostawcy.' },
  { name: 'Gray Swan AI', aliases: ['Gray Swan AI', 'Greyswan AI'], nip: '0000000000', desc: 'Gray Swan AI jest konkurentem Wisent w obszarze bezpieczeństwa, red-teamingu oraz ewaluacji modeli sztucznej inteligencji. Firma rozwija platformę do adversarial evaluation, testowania podatności modeli i agentów AI oraz ochrony wdrożeń produkcyjnych przed atakami takimi jak jailbreaki, prompt injection czy niepożądane wyjścia modelu. Rozwiązania kieruje do laboratoriów frontier AI i przedsiębiorstw wdrażających systemy AI w środowiskach o wysokich wymaganiach bezpieczeństwa. Przewagą Gray Swan jest pozycja w testowaniu bezpieczeństwa i ochronie runtime. Przewaga Wisent polega na przesunięciu kontroli głębiej, z warstwy zewnętrznego testowania i filtrowania na poziom samej architektury modelu.' },
];

const md23 = readFileSync(SOURCE_23, 'utf8');
const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();

function between(start, end) {
  const after = md23.split(start)[1];
  if (after === undefined) throw new Error(`source marker not found: ${start}`);
  return end ? after.split(end)[0] : after;
}

function tableRows(block, expectedCells) {
  return block.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => clean(cell)))
    .filter((cells) => cells.length >= expectedCells && !/Podmiot konkurencyjny|Pole/.test(cells[0]));
}

function parseCompetitionRows(start, end) {
  return tableRows(between(start, end), 5).map((cells) => ({
    producer: cells[0],
    product: cells[2],
    functions: cells[3],
    advantage: cells[4],
  }));
}

function parseParameters() {
  const block = between('## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE', '## Podsumowanie zmian');
  return block.split(/^### Parametr \d+\s*$/m).slice(1).map((part) => {
    const map = new Map();
    for (const cells of tableRows(part, 2)) map.set(cells[0], cells[1]);
    return {
      name: map.get('Nazwa parametru'),
      baseValue: map.get('Wartość bazowa (z jednostką miary)'),
      baseYear: map.get('Rok bazowy'),
      targetValue: map.get('Wartość docelowa (z jednostką miary)'),
      targetYear: map.get('Rok docelowy'),
      estimate: map.get('Metoda oszacowania wartości docelowej'),
      verify: map.get('Sposób monitorowania / weryfikacji osiągnięcia zaplanowanych wartości docelowych'),
    };
  }).filter((row) => row.name && row.targetValue && row.targetYear);
}

const euCompetition = parseCompetitionRows('## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE');
const nonEuCompetition = parseCompetitionRows('## Oferta konkurencji spoza UE', '## Rynek docelowy');
const parameters23 = parseParameters();

const session = await WSession.start({ label: 'ncbr_repair_competition_2_3_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(35000);

function progress(message) {
  console.log(`[repair_competition_2_3] ${new Date().toISOString()} ${message}`);
}

async function setReactInputValue(locator, value) {
  await locator.waitFor({ state: 'visible' });
  await locator.click({ force: true }); // allow-raw-playwright: focus visible LSI field
  const max = Number(await locator.getAttribute('maxlength')) || String(value || '').length;
  let next = String(value || '');
  if (next.length > max) next = next.slice(0, max).replace(/\s+\S*$/, '');
  const locked = await locator.evaluate((el) => Boolean(el.readOnly || el.disabled)); // allow-raw-playwright: inspect visible field mutability
  if (!locked) {
    await locator.fill(''); // allow-raw-playwright: clear editable LSI field
    await locator.fill(next); // allow-raw-playwright: fill editable LSI field
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
  }); // allow-raw-playwright: accept visible statute checkbox for login only
  await humanIdlePause('short');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#login-btn') || Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Zaloguj');
    return !!btn && !btn.disabled;
  }, null, { timeout: 10000 }).catch(() => null); // allow-raw-playwright: wait for LSI login validation
  for (let attempt = 1; attempt <= 3 && page.url().includes('/logowanie'); attempt += 1) {
    await page.locator('#login-btn, button:has-text("Zaloguj")').first().click({ force: true }); // allow-raw-playwright: click visible login button
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await humanIdlePause('long');
  }
  if (page.url().includes('/logowanie')) throw new Error('login stayed on login page');
  progress('login:done');
}

async function readSectionTables(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: navigate to exact LSI section
  await humanIdlePause('long');
  return page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table) => ({
    rows: table.querySelectorAll('tbody tr').length,
    text: table.innerText.replace(/\s+/g, ' ').trim(),
  }))); // allow-raw-playwright: read visible table text only
}

async function visibleTableText() {
  return page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table) => table.innerText.replace(/\s+/g, ' ').trim()).join('\n')); // allow-raw-playwright: read visible table text only
}

function hasAnyName(text, row) {
  const names = [row.name, row.producer, ...(row.aliases || [])].filter(Boolean);
  return names.some((name) => text.includes(name));
}

async function clickDodaj(nth) {
  await page.evaluate((index) => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj' && b.getClientRects().length);
    if (!buttons[index]) throw new Error(`Dodaj #${index} not found; visible count=${buttons.length}`);
    buttons[index].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, nth); // allow-raw-playwright: open visible collection row form
  await humanIdlePause('long');
}

async function saveVisibleForm() {
  progress('save:waiting');
  await humanIdlePause('deliberate');
  await humanIdlePause('deliberate');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length), null, { timeout: 25000 }).catch(() => null); // allow-raw-playwright: wait for enabled visible LSI save
  await page.evaluate(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) throw new Error('no enabled visible Zapisz');
    saves[saves.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }); // allow-raw-playwright: save visible LSI row form
  await humanIdlePause('long');
  progress('save:done');
}

async function selectApplicantIfPresent() {
  const state = await page.evaluate(() => {
    const input = Array.from(document.querySelectorAll('input')).find((el) => /nazwa_skrocona_wnioskodawcy/.test(el.name || ''));
    if (!input) return 'absent';
    const root = input.closest('.MuiFormControl-root') || input.closest('.MuiInputBase-root') || input.parentElement;
    const current = `${input.value || ''} ${root?.innerText || ''}`;
    if (/Wisent Polska/.test(current)) return 'already';
    const opener = root?.querySelector('.MuiSelect-select, [role="combobox"]');
    if (!opener) return 'no-opener';
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) opener.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return 'opened';
  }); // allow-raw-playwright: open visible applicant select if present
  if (state !== 'opened') return state;
  await humanIdlePause('deliberate');
  const opt = page.getByRole('option', { name: 'Wisent Polska', exact: true }).first();
  if (await opt.count() > 0) await opt.dispatchEvent('click'); // allow-raw-playwright: select visible applicant option
  await humanIdlePause('short');
  return state;
}

async function fillNamedField(name, value) {
  const visible = page.locator(`input[name="${name}"]:visible, textarea[name="${name}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`input[name="${name}"], textarea[name="${name}"]`).last();
  return { name, ...(await setReactInputValue(loc, value)) };
}

async function fillBySuffix(suffix, value) {
  const visible = page.locator(`input[name$="${suffix}"]:visible, textarea[name$="${suffix}"]:visible`);
  const loc = (await visible.count() > 0) ? visible.last() : page.locator(`input[name$="${suffix}"], textarea[name$="${suffix}"]`).last();
  return { suffix, ...(await setReactInputValue(loc, value)) };
}

async function addCompetitor14(row) {
  progress(`1.4:add:${row.name}`);
  await clickDodaj(0);
  await page.waitForSelector('[name="nazwa_podmiotu_konkurencyjnego"]');
  const applicant = await selectApplicantIfPresent();
  const fields = [];
  fields.push(await fillNamedField('nazwa_podmiotu_konkurencyjnego', row.name));
  fields.push(await fillNamedField('nip', row.nip));
  fields.push(await fillNamedField('opis', row.desc));
  await saveVisibleForm();
  return { added: row.name, applicant, fields };
}

async function addCompetition23(tableIndex, row) {
  progress(`2.3:add-competition:${row.producer}`);
  await clickDodaj(tableIndex);
  const fields = [];
  fields.push(await fillNamedField('produkt_proces', `${row.product}\n\nFunkcjonalności: ${row.functions}`));
  fields.push(await fillNamedField('nazwa_producenta', row.producer));
  fields.push(await fillNamedField('korzysc_przewaga', row.advantage));
  await saveVisibleForm();
  return { added: row.producer, fields };
}

async function dumpOpenFields() {
  return page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map((el) => ({
    tag: el.tagName,
    name: el.name || null,
    type: el.type || null,
    max: el.getAttribute('maxlength'),
    value: (el.value || '').slice(0, 100),
    visible: Boolean(el.getClientRects().length),
  })).filter((field) => field.name || field.value)); // allow-raw-playwright: diagnostic read of open row fields
}

async function addParameter23(row) {
  progress(`2.3:add-parameter:${row.name}`);
  await clickDodaj(2);
  const fields = [];
  fields.push(await fillBySuffix('nazwa_parametru', row.name));
  fields.push(await fillBySuffix('wartosc_bazowa', row.baseValue));
  fields.push(await fillBySuffix('rok_bazowy', row.baseYear));
  fields.push(await fillBySuffix('wartosc_docelowa', row.targetValue));
  fields.push(await fillBySuffix('rok_docelowy', row.targetYear));
  fields.push(await fillBySuffix('metoda_szacowania_wartosci_docelowej', row.estimate));
  fields.push(await fillBySuffix('sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych', row.verify));
  await saveVisibleForm();
  return { added: row.name, fields };
}

async function editVisibleRowContaining(text) {
  await page.evaluate((needle) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const row = rows.find((candidate) => (candidate.innerText || '').includes(needle));
    if (!row) throw new Error(`visible row not found: ${needle}`);
    const button = row.querySelector('button[aria-label="overflow-options"]');
    if (!button) throw new Error(`row menu not found: ${needle}`);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, text); // allow-raw-playwright: open visible collection row menu by exact row text
  await humanIdlePause('deliberate');
  await page.getByRole('menuitem', { name: 'Edytuj', exact: true }).first().dispatchEvent('click'); // allow-raw-playwright: edit selected visible row
  await humanIdlePause('long');
}

async function repairVisibleMissingNips14() {
  await page.goto(URLS['1.4'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 1.4 navigation for row repair
  await humanIdlePause('long');
  const repaired = [];
  for (const row of competitors14) {
    const rowText = await page.evaluate((names) => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      const hit = rows.find((candidate) => names.some((name) => (candidate.innerText || '').includes(name)));
      return hit ? (hit.innerText || '').replace(/\s+/g, ' ').trim() : null;
    }, [row.name, ...(row.aliases || [])]); // allow-raw-playwright: read matching visible row text
    if (!rowText || rowText.includes(row.nip)) continue;
    progress(`1.4:repair-nip:${row.name}`);
    await editVisibleRowContaining((row.aliases || [row.name]).find((name) => rowText.includes(name)) || row.name);
    await fillNamedField('nip', row.nip);
    await saveVisibleForm();
    repaired.push(row.name);
    await page.goto(URLS['1.4'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: reload table after row repair
    await humanIdlePause('long');
  }
  return repaired;
}

async function validateProject() {
  progress('validate:start');
  const responses = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/validate-project')) return;
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    responses.push({ status: res.status(), url: res.url(), text });
  });
  await page.goto(PROJECT_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: validation-only project navigation
  await humanIdlePause('long');
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Sprawdź wniosek' && !b.disabled);
    if (!btn) return { clicked: false, reason: 'enabled Sprawdz wniosek button not found' };
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { clicked: true };
  }); // allow-raw-playwright: validation-only; never submit
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
      for (const err of sec.validationResult?.errors || []) jsonSchemaErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message });
    }
    for (const sec of parsed.expressionValidationErrors || []) {
      for (const err of sec.validationResult?.errors || []) expressionErrors.push({ sectionId: sec.sectionId, dataPath: err.dataPath, message: err.message });
    }
  }
  return { clicked, status: response.status, jsonSchemaErrors, expressionErrors, rawHead: response.text.slice(0, 500) };
}

async function run() {
  const out = { parsed: { competitors14: competitors14.length, euCompetition: euCompetition.length, nonEuCompetition: nonEuCompetition.length, parameters23: parameters23.length }, actions: [] };
  progress(`parsed:${JSON.stringify(out.parsed)}`);
  await login();

  if (process.env.REPAIR_14_NIPS === '1') {
    out.repairedNips14 = await repairVisibleMissingNips14();
    out.readback = { '1.4': await readSectionTables(URLS['1.4']) };
    if (process.env.VALIDATE === '1') out.validation = await validateProject();
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ out: OUT, parsed: out.parsed, repairedNips14: out.repairedNips14, readback: out.readback, validation: out.validation || null }, null, 2));
    await session.ctx.close();
    return;
  }

  if (process.env.DIAG_PARAM === '1') {
    await page.goto(URLS['2.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 2.3 diagnostic navigation
    await humanIdlePause('long');
    await clickDodaj(2);
    out.diagParamFields = await dumpOpenFields();
    console.log(JSON.stringify(out, null, 2));
    await session.ctx.close();
    return;
  }

  await page.goto(URLS['1.4'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 1.4 navigation
  progress('section:1.4');
  await humanIdlePause('long');
  for (const row of competitors14) {
    const current = await visibleTableText();
    if (hasAnyName(current, row)) {
      progress(`1.4:skip:${row.name}`);
      out.actions.push({ section: '1.4', skippedExisting: row.name });
      continue;
    }
    out.actions.push({ section: '1.4', ...(await addCompetitor14(row)) });
  }

  await page.goto(URLS['2.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 2.3 navigation
  progress('section:2.3');
  await humanIdlePause('long');
  for (const row of euCompetition) {
    const current = await visibleTableText();
    if (current.includes(row.producer)) {
      progress(`2.3:skip-competition:${row.producer}`);
      out.actions.push({ section: '2.3 UE', skippedExisting: row.producer });
      continue;
    }
    out.actions.push({ section: '2.3 UE', ...(await addCompetition23(0, row)) });
  }
  for (const row of nonEuCompetition) {
    const current = await visibleTableText();
    if (current.includes(row.producer)) {
      progress(`2.3:skip-competition:${row.producer}`);
      out.actions.push({ section: '2.3 nonUE', skippedExisting: row.producer });
      continue;
    }
    out.actions.push({ section: '2.3 nonUE', ...(await addCompetition23(1, row)) });
  }
  for (const row of parameters23) {
    const current = await visibleTableText();
    if (current.includes(row.name)) {
      progress(`2.3:skip-parameter:${row.name}`);
      out.actions.push({ section: '2.3 parametry', skippedExisting: row.name });
      continue;
    }
    out.actions.push({ section: '2.3 parametry', ...(await addParameter23(row)) });
  }

  out.readback = {
    '1.4': await readSectionTables(URLS['1.4']),
    '2.3': await readSectionTables(URLS['2.3']),
  };
  if (process.env.VALIDATE === '1') out.validation = await validateProject();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ out: OUT, parsed: out.parsed, actions: out.actions.map((a) => ({ section: a.section, added: a.added, skippedExisting: a.skippedExisting })), readback: out.readback, validation: out.validation || null }, null, 2));
  await session.ctx.close();
}

await run();
process.exit(0);
