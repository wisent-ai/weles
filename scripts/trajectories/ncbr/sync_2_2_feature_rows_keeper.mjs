// UI-only synchronizer for existing section 2.2 feature collection rows.
// Uses keeper session, never submits, never calls LSI APIs.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const WELES = `${ROOT}/weles`;
const BACKENDS = `${ROOT}/backends`;
const SRC = `${BACKENDS}/STEP_sciezka_A_Wisent/wersja_B_2.2_innowacyjnosc_i_zaleznosci.md`;
const OUT = `${BACKENDS}/STEP_sciezka_A_Wisent/sync_2_2_feature_rows_evidence_20260625.json`;
const URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/80ebca16-a9dd-4798-a334-5ac007cecbf7';

const clean = (s) => String(s || '')
  .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();
const md = readFileSync(SRC, 'utf8');

function tableRows(block) {
  return block.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map(clean))
    .filter((cells) => cells.length >= 2 && cells[0] !== 'Pole');
}

function rowValue(block, label) {
  const row = tableRows(block).find((cells) => clean(cells[0]).toLowerCase() === label.toLowerCase());
  if (!row) throw new Error(`missing feature cell: ${label}`);
  return row[1];
}

function parseFeatures() {
  const start = md.indexOf('## Podsumowanie cech i funkcjonalności rezultatu projektu');
  const end = md.indexOf('## Rezultat prac B+R spełnia następujące czynniki', start);
  if (start < 0 || end < 0) throw new Error('feature section markers not found');
  return md.slice(start, end)
    .split(/^### Cecha\/funkcjonalność \d+:/m)
    .slice(1)
    .map((block) => ({
      cecha: rowValue(block, 'Cecha/funkcjonalność rezultatu projektu'),
      bazowa: rowValue(block, 'Wartość bazowa (z jednostką miary)'),
      docelowa: rowValue(block, 'Wartość docelowa (z jednostką miary)'),
      referencyjny: rowValue(block, 'Produkt/proces referencyjny'),
      korzysc: rowValue(block, 'Korzyść/przewaga'),
      weryfikacja: rowValue(block, 'Sposób weryfikacji osiągnięcia wartości docelowej'),
    }));
}

const sourceFeatures = parseFeatures();
if (sourceFeatures.length < 8) throw new Error(`expected at least 8 source features, got ${sourceFeatures.length}`);

function action(args, timeout = 120000, optional = false) {
  const result = spawnSync('node', ['scripts/_shared/keeper/action.mjs', ...args], {
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
  if (!out) throw new Error(`empty keeper output for ${args.join(' ')}`);
  return JSON.parse(out);
}

function read(js, timeout = 120000) {
  return action(['eval', js], timeout).result;
}

function idle(kind = 'short') {
  action(['humanidle', kind], 60000, true);
}

function fill(name, value) {
  const check = read(`(() => {
    const name = ${JSON.stringify(name)};
    const value = ${JSON.stringify(value)};
    const el = document.querySelector('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]');
    if (!el) return { ok: false, error: 'missing', name };
    const max = Number(el.getAttribute('maxlength')) || value.length;
    if (value.length > max) return { ok: false, error: 'over-limit', name, len: value.length, max };
    return { ok: true, name, len: value.length, max };
  })()`);
  if (!check?.ok) throw new Error(`fill precheck failed ${name}: ${JSON.stringify(check)}`);
  action(['fill_fast', `textarea[name="${name}"], input[name="${name}"]`, value], 120000);
  idle('short');
  const out = read(`(() => {
    const name = ${JSON.stringify(name)};
    const el = document.querySelector('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]');
    return el ? { ok: true, name, len: (el.value || '').length, max: Number(el.getAttribute('maxlength')) || null } : { ok: false, error: 'missing-after-fill', name };
  })()`);
  if (!out?.ok) throw new Error(`fill failed ${name}: ${JSON.stringify(out)}`);
  return out;
}

function clickRow(rowNumberOneBased) {
  const text = read(`(() => {
    const row = Array.from(document.querySelectorAll('table tbody tr'))[${rowNumberOneBased - 1}];
    return row ? row.innerText.replace(/\\s+/g, ' ').slice(0, 220) : null;
  })()`);
  if (!text) throw new Error(`row missing: ${rowNumberOneBased}`);
  action(['click', `:nth-match(table tbody tr, ${rowNumberOneBased}) button[aria-label="overflow-options"]`], 90000);
  idle('short');
  action(['click', 'text="Edytuj"'], 60000);
  idle('long');
  return { ok: true, rowNumber: rowNumberOneBased, text };
}

function deleteRow(rowNumberOneBased) {
  const text = read(`(() => {
    const row = Array.from(document.querySelectorAll('table tbody tr'))[${rowNumberOneBased - 1}];
    return row ? row.innerText.replace(/\\s+/g, ' ').slice(0, 220) : null;
  })()`);
  if (!text) throw new Error(`row missing for delete: ${rowNumberOneBased}`);
  action(['click', `:nth-match(table tbody tr, ${rowNumberOneBased}) button[aria-label="overflow-options"]`], 90000);
  idle('short');
  action(['click', 'text="Usuń"'], 60000);
  idle('deliberate');
  const confirm = action(['click', 'button:has-text("Usuń"), button:has-text("Tak"), button:has-text("Potwierdź")'], 60000, true);
  idle('long');
  return { open: { ok: true, rowNumber: rowNumberOneBased, text }, confirm };
}

function saveSubform() {
  const clicked = action(['click', '#collection-obj-form-save-btn'], 90000, true);
  if (clicked.ok !== false) {
    idle('long');
    const status = read(`(() => {
      const b = document.querySelector('#collection-obj-form-save-btn');
      return b ? { stillOpen: true, disabled: b.disabled } : { stillOpen: false, disabled: null };
    })()`);
    if (!status.stillOpen) return { ok: true, method: 'keeper-click-id' };
    if (status.disabled) {
      action(['click', '#collection-obj-form-cancel-btn'], 60000, true);
      idle('long');
      const closed = read(`(() => !document.querySelector('#collection-obj-form-save-btn'))()`);
      if (closed) return { ok: true, method: 'keeper-click-id-disabled-close' };
    }
  }
  const lengths = rowFieldLengths();
  throw new Error(`save click did not close form: ${JSON.stringify(lengths)}`);
}

function rowCounts() {
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t) => t.querySelectorAll('tbody tr').length))()`);
}

function rowFieldLengths() {
  return read(`(() => {
    const names = [
      'cecha_funkcjonalnosc_rezultatu_projektu',
      'wartosc_bazowa',
      'wartosc_docelowa',
      'produkt_proces_referencyjny',
      'korzysc_przewaga',
      'sposob_weryfikacji_osiagniecia_wartosci_docelowej',
    ];
    return names.map((name) => {
      const el = document.querySelector('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]');
      return el ? { name, len: (el.value || '').length, max: Number(el.getAttribute('maxlength')) || null, tail: (el.value || '').slice(-120) } : { name, missing: true };
    });
  })()`);
}

function syncRow(rowNumberOneBased, feature) {
  console.log(JSON.stringify({ stage: 'open-row', row: rowNumberOneBased, cecha: feature.cecha.slice(0, 80) }));
  const opened = clickRow(rowNumberOneBased);
  console.log(JSON.stringify({ stage: 'fill-row', row: rowNumberOneBased }));
  const fills = [
    fill('cecha_funkcjonalnosc_rezultatu_projektu', feature.cecha),
    fill('wartosc_bazowa', feature.bazowa),
    fill('wartosc_docelowa', feature.docelowa),
    fill('produkt_proces_referencyjny', feature.referencyjny),
    fill('korzysc_przewaga', feature.korzysc),
    fill('sposob_weryfikacji_osiagniecia_wartosci_docelowej', feature.weryfikacja),
  ];
  const lengthsBeforeSave = rowFieldLengths();
  console.log(JSON.stringify({ stage: 'save-row', row: rowNumberOneBased, lengths: lengthsBeforeSave.map((f) => `${f.len}/${f.max}`) }));
  const save = saveSubform();
  console.log(JSON.stringify({ stage: 'saved-row', row: rowNumberOneBased, save }));
  return { rowNumberOneBased, opened, fills, lengthsBeforeSave, save };
}

action(['nav', URL], 180000);
idle('long');
const beforeCounts = rowCounts();

const dataRows = beforeCounts[0] ? beforeCounts[0] - 1 : 0;
if (dataRows < 1) throw new Error(`no feature rows visible: ${JSON.stringify(beforeCounts)}`);

const synced = [];
const rowsToSync = Math.min(dataRows, sourceFeatures.length);
for (let dataIndex = 0; dataIndex < rowsToSync; dataIndex += 1) {
  const feature = sourceFeatures[dataIndex];
  synced.push(syncRow(dataIndex + 2, feature)); // row 1 is the "Pozostale" group row.
  action(['nav', URL], 180000);
  idle('long');
}

const deleted = [];
let countsAfterSync = rowCounts();
while ((countsAfterSync[0] || 0) > sourceFeatures.length + 1) {
  deleted.push(deleteRow(countsAfterSync[0]));
  action(['nav', URL], 180000);
  idle('long');
  countsAfterSync = rowCounts();
}

const after = read(`(() => Array.from(document.querySelectorAll('table')).map((t, i) => ({
  i,
  rows: t.querySelectorAll('tbody tr').length,
  text: Array.from(t.querySelectorAll('tbody tr')).map((r) => r.innerText.trim().replace(/\\s+/g, ' ').slice(0, 400))
})))()`);

const evidence = { ok: true, sourceFeatures: sourceFeatures.length, beforeCounts, dataRows, synced, deleted, after, finishedAt: new Date().toISOString() };
writeFileSync(OUT, JSON.stringify(evidence, null, 2));

console.log(JSON.stringify({
  ok: true,
  out: OUT,
  sourceFeatures: sourceFeatures.length,
  dataRows,
  deleted,
  afterRows: after.map((t) => t.rows),
  synced: synced.map((r) => ({ row: r.rowNumberOneBased, lengths: r.lengthsBeforeSave })),
}, null, 2));
