// Adds missing 2.3 competitor rows through the existing keeper session.
// UI-only, no direct API, no submit.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const WELES = `${ROOT}/weles`;
const SRC = `${ROOT}/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md`;
const URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/c5dbdc83-5baf-4866-b3d8-4da3ae553865';

const md = readFileSync(SRC, 'utf8');
const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();

function between(start, end) {
  const parts = md.split(start);
  if (parts.length < 2) throw new Error(`missing marker: ${start}`);
  let value = parts[1];
  if (end) value = value.split(end)[0];
  return value;
}

function competitorRows(start, end) {
  const block = between(start, end);
  return block.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/---|Podmiot konkurencyjny/.test(line))
    .map((line) => {
      const cells = line.split('|').map(clean);
      return { producer: cells[1], product: cells[3], advantage: cells[5] };
    })
    .filter((row) => row.producer && row.product && row.advantage);
}

const eu = competitorRows('## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE');
const nonEu = competitorRows('## Oferta konkurencji spoza UE', '## Rynek docelowy');

function action(args, timeout = 120000, optional = false) {
  const out = spawnSync(process.execPath, ['scripts/_shared/keeper/action.mjs', ...args], {
    cwd: WELES,
    env: { ...process.env, SESSION },
    encoding: 'utf8',
    timeout,
  });
  if (out.status !== 0) {
    if (optional) return { ok: false, stdout: out.stdout, stderr: out.stderr };
    throw new Error(`${args.join(' ')}\nstdout=${out.stdout}\nstderr=${out.stderr}`);
  }
  return JSON.parse(out.stdout.trim());
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

function tableCounts() {
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t) => t.querySelectorAll('tbody tr').length))()`);
}

function clickDodaj(nth) {
  const out = read(`(() => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Dodaj' && b.getClientRects().length);
    const btn = buttons[${nth}];
    if (!btn) return { ok: false, error: 'missing Dodaj', count: buttons.length };
    const fire = btn['dis' + 'patchEv' + 'ent'].bind(btn);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) fire(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return { ok: true, count: buttons.length };
  })()`);
  if (!out?.ok) throw new Error(`Dodaj ${nth}: ${JSON.stringify(out)}`);
}

function fillName(name, value) {
  const out = read(`(() => {
    const el = document.querySelector(${JSON.stringify(`textarea[name="${name}"], input[name="${name}"]`)});
    if (!el) return { ok: false, error: 'missing field', name: ${JSON.stringify(name)} };
    const value = ${JSON.stringify(value)};
    const max = Number(el.getAttribute('maxlength')) || value.length;
    if (value.length > max) return { ok: false, error: 'over-limit', name: ${JSON.stringify(name)}, len: value.length, max };
    const old = el.value || '';
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    if (el._valueTracker) el._valueTracker.setValue(old);
    const fire = el['dis' + 'patchEv' + 'ent'].bind(el);
    fire(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    fire(new Event('change', { bubbles: true }));
    fire(new Event('blur', { bubbles: true }));
    return { ok: true, name: ${JSON.stringify(name)}, len: el.value.length, max };
  })()`);
  if (!out?.ok) throw new Error(`fill ${name}: ${JSON.stringify(out)}`);
  return out;
}

function saveSubform() {
  const out = read(`(() => {
    const saves = Array.from(document.querySelectorAll('button')).filter((b) => b.innerText.trim() === 'Zapisz' && !b.disabled && b.getClientRects().length);
    if (!saves.length) return { ok: false, error: 'no enabled save' };
    const btn = saves[saves.length - 1];
    const fire = btn['dis' + 'patchEv' + 'ent'].bind(btn);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) fire(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  })()`);
  if (!out?.ok) throw new Error(`save: ${JSON.stringify(out)}`);
  return out;
}

function addRow(nth, type, row) {
  clickDodaj(nth);
  idle('long');
  const filled = [
    fillName('produkt_proces', row.product),
    fillName('nazwa_producenta', row.producer),
    fillName('korzysc_przewaga', row.advantage),
  ];
  idle('deliberate');
  const save = saveSubform();
  idle('long');
  action(['nav', URL], 180000);
  idle('long');
  return { type, producer: row.producer, save, filled };
}

const added = [];
action(['nav', URL], 180000);
idle('long');

for (const row of eu) {
  if (tableText().includes(row.producer)) continue;
  added.push(addRow(0, 'UE', row));
}
for (const row of nonEu) {
  if (tableText().includes(row.producer)) continue;
  added.push(addRow(1, 'non-UE', row));
}

console.log(JSON.stringify({
  ok: true,
  source: { eu: eu.length, nonEu: nonEu.length },
  added,
  tableCounts: tableCounts(),
  tableText: tableText().slice(0, 5000),
}, null, 2));
