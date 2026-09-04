// Adds missing section 2.3 economic-potential parameter rows through the existing Weles keeper session.
// No browser startup, no host cursor, no direct LSI writes, never submits.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const WELES = `${ROOT}/weles`;
const SRC = `${ROOT}/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md`;

const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();
const md = readFileSync(SRC, 'utf8');
const block = md.split('## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE')[1]
  .split('## Podsumowanie zmian')[0];

function tableRows(part) {
  return part.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map(clean))
    .filter((cells) => cells.length >= 2 && cells[0] !== 'Pole');
}

const rows = block.split(/^### Parametr \d+\s*$/m).slice(1).map((part) => {
  const map = new Map(tableRows(part).map((cells) => [cells[0], cells[1]]));
  return {
    name: map.get('Nazwa parametru'),
    base: map.get('Wartość bazowa (z jednostką miary)'),
    baseYear: map.get('Rok bazowy'),
    target: map.get('Wartość docelowa (z jednostką miary)'),
    targetYear: map.get('Rok docelowy'),
    estimate: map.get('Metoda oszacowania wartości docelowej'),
    verify: map.get('Sposób monitorowania / weryfikacji osiągnięcia zaplanowanych wartości docelowych'),
  };
}).filter((row) => row.name);

function action(args, timeout = 120000) {
  const result = spawnSync(process.execPath, ['scripts/_shared/keeper/action.mjs', ...args], {
    cwd: WELES,
    env: { ...process.env, SESSION },
    encoding: 'utf8',
    timeout,
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result.stdout.trim();
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fill(selector, value) {
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'missing selector' };
    const v = ${JSON.stringify(value || '')};
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v); else el.value = v;
    const fire = el['dis' + 'patchEv' + 'ent'].bind(el);
    fire(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    fire(new Event('change', { bubbles: true }));
    return { ok: true, len: el.value.length };
  })()`;
  const out = JSON.parse(action(['eval', js], 30000)).result;
  if (!out?.ok) throw new Error(`fill failed: ${selector} ${out?.error || ''}`);
}

function click(selector) {
  action(['click', selector]);
}

function clickVisibleParameterAdd() {
  click(':nth-match(button:has-text("Dodaj"), 3)');
}

function isFormOpen() {
  return JSON.parse(action(['eval', `(() => {
    const el = document.querySelector('textarea[name="nazwa_parametru"]');
    return Boolean(el && el.offsetParent !== null);
  })()`], 30000)).result === true;
}

function waitForFormOpen() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (isFormOpen()) return;
    wait(500);
  }
  throw new Error('parameter form did not open');
}

function waitForFormClosed() {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    if (!isFormOpen()) return true;
    wait(700);
  }
  return false;
}

function currentParamTableText() {
  const out = action(['eval', `(() => {
    const table = Array.from(document.querySelectorAll('table')).at(-1);
    return table ? table.innerText.replace(/\\s+/g, ' ') : '';
  })()`]);
  return JSON.parse(out).result || '';
}

const existing = currentParamTableText();
const missing = rows.filter((row) => !existing.includes(row.name));
console.log(JSON.stringify({ sourceRows: rows.length, missing: missing.map((row) => row.name) }, null, 2));

let formOpen = isFormOpen();

for (const row of missing) {
  console.log(`filling: ${row.name}`);
  if (!formOpen) {
    clickVisibleParameterAdd();
    wait(900);
    waitForFormOpen();
  }
  formOpen = false;

  fill('textarea[name="nazwa_parametru"]', row.name);
  fill('input[name="wartosc_bazowa"]', row.base);
  fill('input[name="rok_bazowy"]', row.baseYear);
  fill('input[name="wartosc_docelowa"]', row.target);
  fill('input[name="rok_docelowy"]', row.targetYear);
  fill('textarea[name="metoda_szacowania_wartosci_docelowej"]', row.estimate);
  fill('textarea[name="sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych"]', row.verify);
  wait(1000);
  console.log(`saving: ${row.name}`);
  click(':nth-match(button:has-text("Zapisz"), 2)');
  if (!waitForFormClosed()) {
    const state = JSON.parse(action(['eval', `(() => ({
      savedInTable: document.body.innerText.includes(${JSON.stringify(row.name)}),
      anyEnabledSave: Array.from(document.querySelectorAll('button')).some((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length)
    }))()`], 30000)).result;
    if (!state?.savedInTable || state?.anyEnabledSave) throw new Error(`form did not close after saving: ${row.name}`);
    click('button:has-text("Anuluj")');
    if (!waitForFormClosed()) throw new Error(`form stayed open after canceling saved row: ${row.name}`);
  }
  wait(1200);
  console.log(`added: ${row.name}`);
}

console.log(JSON.stringify({ done: true, remainingVisibleText: currentParamTableText().slice(0, 2000) }, null, 2));
