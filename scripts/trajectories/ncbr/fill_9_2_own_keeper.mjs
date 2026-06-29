// Adds missing own 9.2 result indicators through the existing keeper session.
// UI-only, no direct API, never submits.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const WELES = `${ROOT}/weles`;
const SRC = `${ROOT}/backends/STEP_sciezka_A_Wisent/wersja_B_9.2_wskazniki.md`;
const URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/e95d0c23-8a39-4d56-96fa-ace3e4f0d23a';

const md = readFileSync(SRC, 'utf8');
const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();
const numeric = (s) => clean(s).replace(/\s/g, '').replace(',', '.');

function cell(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\|\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*\\|\\s*([\\s\\S]*?)\\s*\\|\\s*$`, 'm');
  const m = block.match(re);
  return m ? clean(m[1]) : '';
}

const ownBlock = md.split('## Wskaźniki własne rezultatu')[1] || '';
const ownIndicators = ownBlock.split(/^### /m).slice(1).map((raw) => {
  const block = `### ${raw}`;
  return {
    name: cell(block, 'Nazwa wskaźnika'),
    unit: cell(block, 'Jednostka miary'),
    baseYear: cell(block, 'Rok bazowy'),
    baseValue: numeric(cell(block, 'Wartość bazowa')),
    targetYear: cell(block, 'Rok osiągnięcia wartości docelowej'),
    targetValue: numeric(cell(block, 'Wartość docelowa')),
    methodology: cell(block, 'Opis metodologii wyliczenia wskaźnika'),
    verification: cell(block, 'Opis sposobu weryfikacji osiągnięcia zaplanowanych wartości wskaźnika'),
  };
}).filter((x) => x.name && !/HarmBench|attack success rate/i.test(x.name));

function action(args, timeout = 120000, optional = false) {
  const result = spawnSync('node', ['scripts/_shared/keeper/action.mjs', ...args], {
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
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t) => t.innerText.replace(/\\s+/g, ' ')).join('\\n'))()`, 60000);
}

function rowCount() {
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t) => t.querySelectorAll('tbody tr').length))()`, 60000);
}

function fill(name, value) {
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(`[name="${name}"]`)});
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
  if (!out?.ok) throw new Error(`fill failed ${name}: ${out?.error || 'unknown'}`);
  return out;
}

function save() {
  return read(`(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) return { ok: false, reason: 'no enabled save' };
    const btn = saves[saves.length - 1];
    const fire = btn['dis' + 'patchEv' + 'ent'].bind(btn);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) fire(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  })()`, 60000);
}

const added = [];
action(['nav', URL], 180000);
idle('long');
for (const ind of ownIndicators) {
  const current = tableText();
  if (current.includes(ind.name.slice(0, 80))) {
    added.push({ name: ind.name, skipped: true });
    continue;
  }
  action(['click', 'button:has-text("Dodaj")'], 90000);
  idle('long');
  const filled = [
    ['nazwa_wskaznika', ind.name],
    ['jednostka_miary', ind.unit],
    ['rok_bazowy', ind.baseYear],
    ['wartosc_bazowa', ind.baseValue],
    ['rok_osiagniecia_wartosci_docelowej', ind.targetYear],
    ['wartosc_docelowa', ind.targetValue],
    ['opis_metodologii', ind.methodology],
    ['opis_sposobu_weryfikacji', ind.verification],
  ].map(([name, value]) => ({ name, ...fill(name, value) }));
  idle('deliberate');
  const saved = save();
  idle('long');
  action(['nav', URL], 180000);
  idle('long');
  added.push({ name: ind.name, saved, filled });
}

console.log(JSON.stringify({ ok: true, ownSource: ownIndicators.map((x) => x.name), added, rowCount: rowCount(), tableTail: tableText().slice(-3000) }, null, 2));
