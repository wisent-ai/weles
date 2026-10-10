import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { shows } from '../../../_shared/page/shows.mjs';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const PART = process.env.PART || 'eu';
const WELES = new URL('../../../../..', import.meta.url).pathname.replace(
  /\/$/,
  '',
);
const SRC = (await import('#ncbr-settings')).applicationFile(
  'wersja_B_2.3_rynek_i_potencjal.md',
);
const OUT = (await import('#ncbr-settings')).applicationFile(
  `sync_2_3_${PART}_evidence_20260625.json`,
);
const URL = (await import('#ncbr-settings')).sectionUrl('2_3');

const clean = (s) =>
  String(s || '')
    .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const md = readFileSync(SRC, 'utf8');

function tableRows(sectionTitle, nextTitle) {
  const start = md.indexOf(sectionTitle);
  const end = md.indexOf(nextTitle, start);
  if (start < 0 || end < 0)
    throw new Error(`table markers missing: ${sectionTitle}`);
  return md
    .slice(start, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map(clean))
    .filter(
      (cells) => cells.length === 5 && cells[0] !== 'Podmiot konkurencyjny',
    )
    .map((cells) => ({
      podmiot: cells[0],
      kraj: cells[1],
      produkt: cells[2],
      funkcjonalnosci: cells[3],
      korzysc: cells[4],
    }));
}

function rowValue(block, label) {
  const line = block
    .split(/\r?\n/)
    .find(
      (l) => l.startsWith('|') && l.toLowerCase().includes(label.toLowerCase()),
    );
  if (!line) throw new Error(`row missing: ${label}`);
  return clean(line.split('|').slice(1, -1)[1]);
}

function paramRows() {
  const title =
    '## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE';
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
  return md
    .slice(start + title.length)
    .split(/^### Parametr \d+\s*$/m)
    .slice(1)
    .map((block, index) => ({
      name: rowValue(block, 'Nazwa parametru'),
      match: oldMatches[index] || rowValue(block, 'Nazwa parametru'),
      base: rowValue(block, 'Wartość bazowa'),
      baseYear: rowValue(block, 'Rok bazowy'),
      target: rowValue(block, 'Wartość docelowa'),
      targetYear: rowValue(block, 'Rok docelowy'),
      method: rowValue(block, 'Metoda oszacowania'),
      verify: rowValue(block, 'Sposób monitorowania'),
    }));
}

const rowsByPart = {
  eu: tableRows(
    '## Oferta konkurencji wewnątrz UE',
    '## Oferta konkurencji spoza UE',
  ),
  non_eu: tableRows(
    '## Oferta konkurencji spoza UE',
    '## Rynek docelowy dla innowacji produktowej',
  ),
  params: paramRows(),
};

let rows = rowsByPart[PART];
if (!rows) throw new Error(`bad PART ${PART}`);
if (process.env.ONLY) {
  const needle = process.env.ONLY.toLowerCase();
  rows = rows.filter((row) =>
    JSON.stringify(row).toLowerCase().includes(needle),
  );
  if (!rows.length)
    throw new Error(`ONLY did not match any row: ${process.env.ONLY}`);
}

function action(args, optional = false) {
  const result = spawnSync(
    process.execPath,
    ['src/trajectories/_shared/keeper/action.mjs'],
    {
      cwd: WELES,
      env: { ...process.env, SESSION },
      encoding: 'utf8',
      input: JSON.stringify(args),
    },
  );
  if (result.status !== 0) {
    if (optional)
      return {
        ok: false,
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
      };
    throw new Error(
      `${args.action}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  const out = String(result.stdout || '').trim();
  if (!out) {
    if (optional) return { ok: true, empty: true };
    throw new Error(`empty keeper output for ${args.action}`);
  }
  return JSON.parse(out);
}

const read = (js) => action({ action: 'eval', js: js }).result;
const idle = (kind = 'short') => action({ action: 'settle' }, true);

function fill(name, value) {
  const check = read(`(() => {
    const name = ${JSON.stringify(name)};
    const value = ${JSON.stringify(value)};
    const el = Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null);
    if (!el) return { ok: false, error: 'missing', name };
    const max = Number(el.getAttribute('maxlength')) || value.length;
    return { ok: value.length <= max, name, tag: el.tagName.toLowerCase(), len: value.length, max, currentLen: (el.value || '').length };
  })()`);
  if (!check?.ok)
    throw new Error(`fill precheck failed ${name}: ${JSON.stringify(check)}`);
  action({
    action: 'fill',
    selector: `${check.tag}[name="${name}"]`,
    text: value,
  });
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

// A row matches when one of its cells shows the needle whole or by its
// ellipsis-closed start (shows.mjs); its menu is then opened by the row's own
// whole text, so no prefix length is chosen here.
function openByNeedle(needle) {
  const rowText = read(`(() => {
    const shows = ${shows.toString()};
    const needle = ${JSON.stringify(needle)};
    const row = Array.from(document.querySelectorAll('table tbody tr')).find((tr) =>
      Array.from(tr.cells).some((td) => shows(td.innerText, needle)),
    );
    return row ? row.innerText.replace(/\\s+/g, ' ').trim() : null;
  })()`);
  if (rowText === null) throw new Error(`row not found by text: ${needle}`);
  const menuSelector = `table tbody tr:has-text(${JSON.stringify(rowText)}) button[aria-label="overflow-options"]`;
  action({ action: 'click', selector: menuSelector });
  idle();
  const openedMenu = read(
    `(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).some((el) => el.offsetParent !== null && el.innerText.trim() === 'Edytuj'))()`,
  );
  if (!openedMenu) throw new Error(`edit menu did not open for row: ${needle}`);
  action({ action: 'click', selector: 'text="Edytuj"' });
  idle('long');
  return { row: rowText };
}

function openParamByOrdinal(rowOrdinal) {
  const rowText = read(`(() => {
    const table = Array.from(document.querySelectorAll('table'))[2];
    const row = table ? Array.from(table.querySelectorAll('tbody tr'))[${rowOrdinal + 1}] : null;
    return row ? row.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  if (!rowText)
    throw new Error(`parameter row not found by ordinal: ${rowOrdinal + 1}`);
  const selector = `table tbody tr:has-text(${JSON.stringify(rowText)}) button[aria-label="overflow-options"]`;
  action({ action: 'click', selector });
  idle();
  const openedMenu = read(
    `(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).some((el) => el.offsetParent !== null && el.innerText.trim() === 'Edytuj'))()`,
  );
  if (!openedMenu)
    throw new Error(
      `edit menu did not open for parameter row ${rowOrdinal + 1}: ${rowText}`,
    );
  action({ action: 'click', selector: 'text="Edytuj"' });
  idle('long');
  return { index: rowOrdinal + 1, rowText };
}

function saveSubform() {
  action({ action: 'press', key: 'Tab' }, true);
  idle('long');
  action({ action: 'click', selector: '#collection-obj-form-save-btn' });
  // The form is saved when its save button is gone. A disabled button is a
  // save in flight and is waited for; an enabled one did not take the click
  // and is pressed again.
  for (let clicks = 1; ; ) {
    idle('long');
    const status = read(`(() => {
      const b = document.querySelector('#collection-obj-form-save-btn');
      return b ? { disabled: b.disabled, text: b.innerText } : null;
    })()`);
    if (!status) return { ok: true, clicks };
    if (!status.disabled) {
      action(
        { action: 'click', selector: '#collection-obj-form-save-btn' },
        true,
      );
      clicks += 1;
    }
  }
}

action({ action: 'nav', url: URL });
idle('long');

const synced = [];
for (const [rowIndex, row] of rows.entries()) {
  const needle = row.podmiot || row.match || row.name;
  console.log(
    JSON.stringify({ stage: 'open', part: PART, needle, count: rows.length }),
  );
  const opened =
    PART === 'params' ? openParamByOrdinal(rowIndex) : openByNeedle(needle);
  const fills = [];
  if (PART === 'params') {
    fills.push(fill('nazwa_parametru', row.name));
    fills.push(fill('wartosc_bazowa', row.base));
    fills.push(fill('rok_bazowy', row.baseYear));
    fills.push(fill('wartosc_docelowa', row.target));
    fills.push(fill('rok_docelowy', row.targetYear));
    fills.push(fill('metoda_szacowania_wartosci_docelowej', row.method));
    fills.push(
      fill(
        'sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych',
        row.verify,
      ),
    );
  } else {
    fills.push(fill('produkt_proces', row.produkt));
    fills.push(
      optionalFill(
        ['funkcjonalnosci', 'opis_funkcjonalnosci', 'cechy_funkcjonalnosci'],
        row.funkcjonalnosci,
      ),
    );
    fills.push(fill('korzysc_przewaga', row.korzysc));
  }
  console.log(
    JSON.stringify({
      stage: 'filled',
      part: PART,
      needle,
      lengths: fills.map((f) => `${f.name}:${f.len}/${f.max}`),
    }),
  );
  const save = saveSubform();
  console.log(JSON.stringify({ stage: 'saved', part: PART, needle, save }));
  synced.push({ needle, opened, fills, save });
  action({ action: 'nav', url: URL });
  idle('long');
}

const evidence = {
  ok: true,
  part: PART,
  rows: rows.length,
  synced,
  finishedAt: new Date().toISOString(),
};
writeFileSync(OUT, JSON.stringify(evidence, null, 2));
console.log(
  JSON.stringify(
    {
      ok: true,
      out: OUT,
      part: PART,
      rows: rows.length,
      lengths: synced.map((r) => ({
        needle: r.needle,
        fields: r.fills.map((f) => `${f.name}:${f.len}/${f.max}`),
      })),
    },
    null,
    2,
  ),
);
