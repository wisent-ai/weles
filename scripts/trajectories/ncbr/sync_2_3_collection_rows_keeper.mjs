import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const PART = process.env.PART || 'eu';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const WELES = `${ROOT}/weles`;
const BACKENDS = `${ROOT}/backends`;
const SRC = `${BACKENDS}/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md`;
const OUT = `${BACKENDS}/STEP_sciezka_A_Wisent/sync_2_3_${PART}_evidence_20260625.json`;
const URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/c5dbdc83-5baf-4866-b3d8-4da3ae553865';

const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();
const md = readFileSync(SRC, 'utf8');

function tableRows(sectionTitle, nextTitle) {
  const start = md.indexOf(sectionTitle);
  const end = md.indexOf(nextTitle, start);
  if (start < 0 || end < 0) throw new Error(`table markers missing: ${sectionTitle}`);
  return md.slice(start, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map(clean))
    .filter((cells) => cells.length === 5 && cells[0] !== 'Podmiot konkurencyjny')
    .map((cells) => ({ podmiot: cells[0], kraj: cells[1], produkt: cells[2], funkcjonalnosci: cells[3], korzysc: cells[4] }));
}

function rowValue(block, label) {
  const line = block.split(/\r?\n/).find((l) => l.startsWith('|') && l.toLowerCase().includes(label.toLowerCase()));
  if (!line) throw new Error(`row missing: ${label}`);
  return clean(line.split('|').slice(1, -1)[1]);
}

function paramRows() {
  const title = '## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE';
  const start = md.indexOf(title);
  if (start < 0) throw new Error('parameter section missing');
  const oldMatches = [
    'Liczba płatnych odbiorców enterprise spoza rynku wewnętrznego UE korzystających z modeli RNM',
    'Wartość rocznych przychodów netto Wisent Polska ze sprzedaży modeli RNM klientom spoza rynku',
    'Roczne przychody netto Wisent Polska ze sprzedaży modeli RNM klientom enterprise na rynku wewnętrznym UE',
    'Liczba klientów z listy Fortune 500 Europe, którzy w roku docelowym odpłatnie korzystają z modeli RNM',
    'Skumulowane przychody netto Wisent Polska ze sprzedaży modeli RNM na rynku wewnętrznym UE',
    'Roczne przychody Wisent Polska ze sprzedaży modeli RNM do klientów z rynku wewnętrznego UE',
    'Liczba państw członkowskich UE, z których pochodzą płatni klienci enterprise',
    "Liczba odbiorców MŚP, software house'ów i integratorów korzystających z RNM",
    'Liczba miejsc pracy w przeliczeniu na EPC utworzonych w Wisent Polska',
    'Liczba nowych projektów B+R+I uruchomionych przez Wisent w wyniku realizacji projektu',
  ];
  return md.slice(start + title.length)
    .split(/^### Parametr \d+\s*$/m)
    .slice(1)
    .map((block, index) => ({
      name: rowValue(block, 'Nazwa parametru'),
      match: oldMatches[index] || rowValue(block, 'Nazwa parametru').slice(0, 70),
      base: rowValue(block, 'Wartość bazowa'),
      baseYear: rowValue(block, 'Rok bazowy'),
      target: rowValue(block, 'Wartość docelowa'),
      targetYear: rowValue(block, 'Rok docelowy'),
      method: rowValue(block, 'Metoda oszacowania'),
      verify: rowValue(block, 'Sposób monitorowania'),
    }));
}

const rowsByPart = {
  eu: tableRows('## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE'),
  non_eu: tableRows('## Oferta konkurencji spoza UE', '## Rynek docelowy dla innowacji produktowej'),
  params: paramRows(),
};

let rows = rowsByPart[PART];
if (!rows) throw new Error(`bad PART ${PART}`);
if (process.env.ONLY) {
  const needle = process.env.ONLY.toLowerCase();
  rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
  if (!rows.length) throw new Error(`ONLY did not match any row: ${process.env.ONLY}`);
}

function action(args, timeout = 120000, optional = false) {
  const result = spawnSync(process.execPath, ['scripts/_shared/keeper/action.mjs', ...args], {
    cwd: WELES,
    env: { ...process.env, SESSION },
    encoding: 'utf8',
    timeout,
  });
  if (result.status !== 0) {
    if (optional) return { ok: false, stdout: result.stdout, stderr: result.stderr, status: result.status };
    throw new Error(`${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  const out = String(result.stdout || '').trim();
  if (!out) {
    if (optional) return { ok: true, empty: true };
    throw new Error(`empty keeper output for ${args.join(' ')}`);
  }
  return JSON.parse(out);
}

const read = (js) => action(['eval', js], 120000).result;
const idle = (kind = 'short') => action(['humanidle', kind], 60000, true);

function fill(name, value) {
  const check = read(`(() => {
    const name = ${JSON.stringify(name)};
    const value = ${JSON.stringify(value)};
    const el = Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null);
    if (!el) return { ok: false, error: 'missing', name };
    const max = Number(el.getAttribute('maxlength')) || value.length;
    return { ok: value.length <= max, name, tag: el.tagName.toLowerCase(), len: value.length, max, currentLen: (el.value || '').length };
  })()`);
  if (!check?.ok) throw new Error(`fill precheck failed ${name}: ${JSON.stringify(check)}`);
  action(['set_value', `${check.tag}[name="${name}"]`, value], 120000);
  idle('short');
  return read(`(() => {
    const name = ${JSON.stringify(name)};
    const el = Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null);
    return el ? { name, len: (el.value || '').length, max: Number(el.getAttribute('maxlength')) || null } : { name, missing: true };
  })()`);
}

function optionalFill(names, value) {
  const tried = [];
  for (const name of names) {
    const exists = read(`(() => {
      const name = ${JSON.stringify(name)};
      return Boolean(Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null));
    })()`);
    tried.push(name);
    if (exists) return fill(name, value);
  }
  return { name: names[0], len: 0, max: null, skipped: true, tried };
}

function openByNeedle(needle) {
  const shortNeedle = needle.slice(0, 70);
  const idx = read(`(() => {
    const needle = ${JSON.stringify(shortNeedle)};
    const trs = Array.from(document.querySelectorAll('table tbody tr'));
    return trs.findIndex((tr) => tr.innerText.replace(/\\s+/g, ' ').includes(needle));
  })()`);
  if (idx < 0) throw new Error(`row not found by text: ${needle}`);
  const selectorNeedle = shortNeedle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const menuSelector = `table tbody tr:has-text("${selectorNeedle}") button[aria-label="overflow-options"]`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    action([attempt === 0 ? 'click_fast' : 'dispatch_click', menuSelector], 90000, true);
    idle('short');
    const hasEdit = read(`(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).some((el) => el.offsetParent !== null && el.innerText.trim() === 'Edytuj'))()`);
    if (hasEdit) break;
    idle('short');
  }
  const openedMenu = read(`(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).some((el) => el.offsetParent !== null && el.innerText.trim() === 'Edytuj'))()`);
  if (!openedMenu) throw new Error(`edit menu did not open for row: ${needle}`);
  action(['dispatch_click', 'text="Edytuj"'], 60000);
  idle('long');
  return { index: idx + 1 };
}

function openParamByOrdinal(rowOrdinal) {
  const rowText = read(`(() => {
    const table = Array.from(document.querySelectorAll('table'))[2];
    const row = table ? Array.from(table.querySelectorAll('tbody tr'))[${rowOrdinal + 1}] : null;
    return row ? row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 90) : '';
  })()`);
  if (!rowText) throw new Error(`parameter row not found by ordinal: ${rowOrdinal + 1}`);
  const selector = `table tbody tr:has-text(${JSON.stringify(rowText)}) button[aria-label="overflow-options"]`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    action([attempt === 0 ? 'click_fast' : 'dispatch_click', selector], 90000, true);
    idle('short');
    const hasEdit = read(`(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).some((el) => el.offsetParent !== null && el.innerText.trim() === 'Edytuj'))()`);
    if (hasEdit) break;
    idle('short');
  }
  const openedMenu = read(`(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).some((el) => el.offsetParent !== null && el.innerText.trim() === 'Edytuj'))()`);
  if (!openedMenu) throw new Error(`edit menu did not open for parameter row ${rowOrdinal + 1}: ${rowText}`);
  action(['dispatch_click', 'text="Edytuj"'], 60000);
  idle('long');
  return { index: rowOrdinal + 1, rowText };
}

function saveSubform() {
  action(['press', 'Tab'], 60000, true);
  idle('long');
  action(['dispatch_click', '#collection-obj-form-save-btn'], 90000);
  for (let i = 0; i < 10; i += 1) {
    idle('long');
    const status = read(`(() => {
      const b = document.querySelector('#collection-obj-form-save-btn');
      return b ? { disabled: b.disabled, text: b.innerText } : null;
    })()`);
    if (!status) return { ok: true, waited: i + 1 };
    if (!status.disabled && i >= 2) action(['dispatch_click', '#collection-obj-form-save-btn'], 90000, true);
  }
  const status = read(`(() => {
    const b = document.querySelector('#collection-obj-form-save-btn');
    return b ? { disabled: b.disabled, text: b.innerText } : null;
  })()`);
  if (status?.disabled) return { ok: true, method: 'save-button-disabled-after-click-reload-to-continue' };
  throw new Error(`subform did not close after save: ${JSON.stringify(status)}`);
}

action(['nav', URL], 180000);
idle('long');

const synced = [];
for (const [rowIndex, row] of rows.entries()) {
  const needle = row.podmiot || row.match || row.name;
  console.log(JSON.stringify({ stage: 'open', part: PART, needle, count: rows.length }));
  const opened = PART === 'params' ? openParamByOrdinal(rowIndex) : openByNeedle(needle);
  const fills = [];
  if (PART === 'params') {
    fills.push(fill('nazwa_parametru', row.name));
    fills.push(fill('wartosc_bazowa', row.base));
    fills.push(fill('rok_bazowy', row.baseYear));
    fills.push(fill('wartosc_docelowa', row.target));
    fills.push(fill('rok_docelowy', row.targetYear));
    fills.push(fill('metoda_szacowania_wartosci_docelowej', row.method));
    fills.push(fill('sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych', row.verify));
  } else {
    fills.push(fill('produkt_proces', row.produkt));
    fills.push(optionalFill(['funkcjonalnosci', 'opis_funkcjonalnosci', 'cechy_funkcjonalnosci'], row.funkcjonalnosci));
    fills.push(fill('korzysc_przewaga', row.korzysc));
  }
  console.log(JSON.stringify({ stage: 'filled', part: PART, needle, lengths: fills.map((f) => `${f.name}:${f.len}/${f.max}`) }));
  const save = saveSubform();
  console.log(JSON.stringify({ stage: 'saved', part: PART, needle, save }));
  synced.push({ needle, opened, fills, save });
  action(['nav', URL], 180000);
  idle('long');
}

const evidence = { ok: true, part: PART, rows: rows.length, synced, finishedAt: new Date().toISOString() };
writeFileSync(OUT, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, out: OUT, part: PART, rows: rows.length, lengths: synced.map((r) => ({ needle: r.needle, fields: r.fills.map((f) => `${f.name}:${f.len}/${f.max}`) })) }, null, 2));
