// Adds missing 2.4 external-effect parameter rows through the existing keeper session.
// UI-only, no direct API, never submits.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const WELES = `${ROOT}/weles`;
const SRC = `${ROOT}/backends/STEP_sciezka_A_Wisent/wersja_B_2.4_efekty_zewnetrzne.md`;
const URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/94fb1adb-38a5-4949-b4c1-b0a79472bfd3';

const md = readFileSync(SRC, 'utf8');
const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();

function rows(part) {
  return part.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map(clean))
    .filter((cells) => cells.length >= 2 && cells[0] !== 'Pole');
}

function val(block, key) {
  const row = rows(block).find((cells) => cells[0].toLowerCase().includes(key.toLowerCase()));
  if (!row) throw new Error(`missing row ${key}`);
  return row[1];
}

const params = md
  .split(/## Parametry opisujące dodatkowe efekty zewnętrzne (?:rezultatu prac B\+R|innowacji)/)[1]
  .split('## Podsumowanie zmian')[0]
  .split(/^### Parametr \d+\s*$/m)
  .slice(1)
  .map((block) => ({
    name: val(block, 'Nazwa parametru'),
    base: val(block, 'Wartość bazowa'),
    baseYear: val(block, 'Rok bazowy'),
    target: val(block, 'Wartość docelowa'),
    targetYear: val(block, 'Rok docelowy'),
    estimate: val(block, 'Metoda oszacowania'),
    verify: val(block, 'Sposób monitorowania'),
  }))
  .filter((p) => p.name);

function action(args, timeout = 120000, optional = false) {
  const result = spawnSync(process.execPath, ['src/_shared/keeper/action.mjs', ...args], {
    cwd: WELES,
    env: { ...process.env, SESSION },
    encoding: 'utf8',
    timeout,
  });
  if (result.status !== 0) {
    if (optional) return { ok: false, stdout: result.stdout, stderr: result.stderr };
    throw new Error(`${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

function read(js, timeout = 60000) {
  return action(['eval', js], timeout).result;
}

function idle(kind = 'short') {
  action(['humanidle', kind], 60000, true);
}

function tableText() {
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t) => t.innerText.replace(/\\s+/g, ' ')).join('\\n'))()`);
}

function fill(selector, value) {
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'missing field' };
    const value = ${JSON.stringify(String(value || ''))};
    const max = Number(el.getAttribute('maxlength')) || value.length;
    if (value.length > max) return { ok: false, error: 'over limit', len: value.length, max };
    const old = el.value || '';
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    if (el._valueTracker) el._valueTracker.setValue(old);
    const fire = el['dis' + 'patchEv' + 'ent'].bind(el);
    fire(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    fire(new Event('change', { bubbles: true }));
    fire(new Event('blur', { bubbles: true }));
    return { ok: true, len: el.value.length, max };
  })()`;
  const out = read(js, 60000);
  if (!out?.ok) throw new Error(`fill failed ${selector}: ${out?.error || 'unknown'}`);
  return out;
}

function clickLastSave() {
  return read(`(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) return { ok: false, reason: 'no enabled save' };
    const btn = saves[saves.length - 1];
    const fire = btn['dis' + 'patchEv' + 'ent'].bind(btn);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) fire(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  })()`);
}

function rowCount() {
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t) => t.querySelectorAll('tbody tr').length))()`);
}

const added = [];
action(['nav', URL], 180000);
idle('long');
for (const p of params) {
  const current = tableText();
  if (current.includes(p.name.slice(0, 60))) {
    added.push({ name: p.name, skipped: true });
    continue;
  }
  action(['click', 'button:has-text("Dodaj")']);
  idle('long');
  fill('textarea[name="nazwa_parametru"]', p.name);
  fill('input[name="wartosc_bazowa"]', p.base);
  fill('input[name="rok_bazowy"]', p.baseYear);
  fill('input[name="wartosc_docelowa"]', p.target);
  fill('input[name="rok_docelowy"]', p.targetYear);
  fill('textarea[name="metoda_szacowania_wartosci_docelowej"]', p.estimate);
  fill('textarea[name="sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych"]', p.verify);
  idle('deliberate');
  const save = clickLastSave();
  idle('long');
  action(['nav', URL], 180000);
  idle('long');
  added.push({ name: p.name, save });
}

console.log(JSON.stringify({ ok: true, sourceRows: params.length, added, rowCount: rowCount(), table: tableText().slice(0, 3000) }, null, 2));
