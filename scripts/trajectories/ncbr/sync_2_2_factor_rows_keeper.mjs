import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const WELES = `${ROOT}/weles`;
const BACKENDS = `${ROOT}/backends`;
const SRC = `${BACKENDS}/STEP_sciezka_A_Wisent/wersja_B_2.2_innowacyjnosc_i_zaleznosci.md`;
const OUT = `${BACKENDS}/STEP_sciezka_A_Wisent/sync_2_2_factor_rows_evidence_20260625.json`;
const URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/80ebca16-a9dd-4798-a334-5ac007cecbf7';

const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();
const md = readFileSync(SRC, 'utf8');

function parseRows() {
  const start = md.indexOf('## Podsumowanie wpływu prac B+R na ograniczanie lub zwalczanie zależności Unii');
  const end = md.indexOf('## Powiązanie rezultatu prac B+R', start);
  if (start < 0 || end < 0) throw new Error('2.2 factor table markers not found');
  return md.slice(start, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map(clean))
    .filter((cells) => cells.length >= 8 && cells[0] !== 'Wybrany czynnik')
    .map((cells) => ({
      factor: cells[0],
      param: cells[1],
      method: cells[6],
      verify: cells[7],
    }));
}

let rows = parseRows();
if (rows.length !== 5) throw new Error(`expected 5 factor rows, got ${rows.length}`);
if (process.env.ONLY) {
  const needle = process.env.ONLY.toLowerCase();
  rows = rows.filter((row) => `${row.factor} ${row.param}`.toLowerCase().includes(needle));
  if (rows.length === 0) throw new Error(`ONLY did not match any factor row: ${process.env.ONLY}`);
}

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

function loginIfNeeded() {
  const url = action(['url'], 60000, true);
  const current = url.ok === false ? '' : String(url.url || url.result || '');
  if (!/login|logowanie|auth/i.test(current)) return false;
  const email = process.env.NCBR_EMAIL;
  const password = process.env.NCBR_PASSWORD;
  if (!email || !password) throw new Error('login required but NCBR_EMAIL/NCBR_PASSWORD not set');
  action(['fill_fast', 'input#mail, input[name="mail"]', email], 120000);
  action(['fill_fast', 'input#password, input[name="password"]', password], 120000);
  action(['click_fast', 'input[name="isStatuteAccepted"]'], 60000, true);
  action(['click_fast', 'button:has-text("Zaloguj się")'], 120000);
  idle('long');
  idle('long');
  return true;
}

function fill(name, value) {
  const check = read(`(() => {
    const name = ${JSON.stringify(name)};
    const value = ${JSON.stringify(value)};
    const el = Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null);
    if (!el) return { ok: false, error: 'missing', name };
    const max = Number(el.getAttribute('maxlength')) || value.length;
    return { ok: value.length <= max, name, len: value.length, max, currentLen: (el.value || '').length };
  })()`);
  if (!check?.ok) throw new Error(`fill precheck failed ${name}: ${JSON.stringify(check)}`);
  action(['fill_fast', `textarea[name="${name}"]:visible, input[name="${name}"]:visible`, value], 120000);
  idle('short');
  return read(`(() => {
    const name = ${JSON.stringify(name)};
    const el = Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null);
    return el ? { name, len: (el.value || '').length, max: Number(el.getAttribute('maxlength')) || null, tail: (el.value || '').slice(-80) } : { name, missing: true };
  })()`);
}

function openByParam(param) {
  const idx = read(`(() => {
    const needle = ${JSON.stringify(param.slice(0, 70))};
    const trs = Array.from(document.querySelectorAll('table tbody tr'));
    const hit = trs.findIndex((tr) => tr.innerText.replace(/\\s+/g, ' ').includes(needle));
    return hit;
  })()`);
  if (idx < 0) throw new Error(`factor row not found by param: ${param}`);
  const menu = `:nth-match(table tbody tr, ${idx + 1}) button[aria-label="overflow-options"]`;
  action(['click_fast', menu], 90000);
  idle('short');
  action(['click_fast', 'text="Edytuj"'], 60000);
  idle('long');
  return { index: idx + 1 };
}

function saveSubform() {
  action(['dispatch_click', '#collection-obj-form-save-btn'], 90000);
  for (let i = 0; i < 10; i += 1) {
    idle('long');
    const status = read(`(() => {
      const b = document.querySelector('#collection-obj-form-save-btn');
      return b ? { disabled: b.disabled, text: b.innerText } : null;
    })()`);
    if (!status) return { ok: true, waited: i + 1 };
    if (!status.disabled && i >= 2) {
      action(['dispatch_click', '#collection-obj-form-save-btn'], 90000, true);
    }
  }
  const status = read(`(() => {
    const b = document.querySelector('#collection-obj-form-save-btn');
    return b ? { disabled: b.disabled, text: b.innerText } : null;
  })()`);
  if (status?.disabled) return { ok: true, method: 'save-button-disabled-after-click-reload-to-continue' };
  throw new Error(`subform did not close after save: ${JSON.stringify(status)}`);
}

function allRowsText() {
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t, ti) => ({
    table: ti,
    rows: Array.from(t.querySelectorAll('tbody tr')).map((tr, ri) => ({
      row: ri + 1,
      text: tr.innerText.replace(/\\s+/g, ' ').slice(0, 260)
    }))
  })))()`);
}

action(['nav', URL], 180000);
idle('long');
loginIfNeeded();
action(['nav', URL], 180000);
idle('long');

const before = allRowsText();
const synced = [];

for (const row of rows) {
  console.log(JSON.stringify({ stage: 'open', param: row.param, methodLen: row.method.length, verifyLen: row.verify.length }));
  const opened = openByParam(row.param);
  const paramName = fill('nazwa_parametru', row.param);
  console.log(JSON.stringify({ stage: 'filled-param', param: row.param, len: paramName.len, max: paramName.max }));
  const method = fill('metoda_szacowania_wartosci_docelowej', row.method);
  console.log(JSON.stringify({ stage: 'filled-method', param: row.param, len: method.len, max: method.max }));
  const verify = fill('sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych', row.verify);
  console.log(JSON.stringify({ stage: 'filled-verify', param: row.param, len: verify.len, max: verify.max }));
  action(['press', 'Tab'], 60000, true);
  idle('long');
  saveSubform();
  console.log(JSON.stringify({ stage: 'saved', param: row.param }));
  synced.push({ param: row.param, opened, paramName, method, verify });
  action(['nav', URL], 180000);
  idle('long');
}

const after = allRowsText();
const evidence = { ok: true, url: URL, rows: rows.length, before, synced, after, finishedAt: new Date().toISOString() };
writeFileSync(OUT, JSON.stringify(evidence, null, 2));

console.log(JSON.stringify({
  ok: true,
  out: OUT,
  rows: rows.length,
  lengths: synced.map((r) => ({ param: r.param.slice(0, 80), paramName: `${r.paramName.len}/${r.paramName.max}`, method: `${r.method.len}/${r.method.max}`, verify: `${r.verify.len}/${r.verify.max}` })),
}, null, 2));
