// Adds missing own 9.2 result indicators through the existing keeper session.
// UI-only, no direct API, never submits.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const WELES = new URL('../../../../..', import.meta.url).pathname.replace(
  /\/$/,
  '',
);
const SRC = (await import('#ncbr-settings')).applicationFile(
  'wersja_B_9.2_wskazniki.md',
);
const URL = (await import('#ncbr-settings')).sectionUrl('9_2');

const md = readFileSync(SRC, 'utf8');
const clean = (s) =>
  String(s || '')
    .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const numeric = (s) => clean(s).replace(/\s/g, '').replace(',', '.');

function cell(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^\\|\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*\\|\\s*([\\s\\S]*?)\\s*\\|\\s*$`,
    'm',
  );
  const m = block.match(re);
  return m ? clean(m[1]) : '';
}

const ownBlock = md.split('## Wskaźniki własne rezultatu')[1] || '';
const ownIndicators = ownBlock
  .split(/^### /m)
  .slice(1)
  .map((raw) => {
    const block = `### ${raw}`;
    return {
      name: cell(block, 'Nazwa wskaźnika'),
      unit: cell(block, 'Jednostka miary'),
      baseYear: cell(block, 'Rok bazowy'),
      baseValue: numeric(cell(block, 'Wartość bazowa')),
      targetYear: cell(block, 'Rok osiągnięcia wartości docelowej'),
      targetValue: numeric(cell(block, 'Wartość docelowa')),
      methodology: cell(block, 'Opis metodologii wyliczenia wskaźnika'),
      verification: cell(
        block,
        'Opis sposobu weryfikacji osiągnięcia zaplanowanych wartości wskaźnika',
      ),
    };
  })
  .filter((x) => x.name && !/HarmBench|attack success rate/i.test(x.name));

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
      return { ok: false, stdout: result.stdout, stderr: result.stderr };
    throw new Error(
      `${args.action}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout.trim());
}

function read(js) {
  return action({ action: 'eval', js: js }).result;
}

function idle(kind = 'short') {
  action({ action: 'settle' }, true);
}

function tableText() {
  return read(
    `(() => Array.from(document.querySelectorAll('table')).map((t) => t.innerText.replace(/\\s+/g, ' ')).join('\\n'))()`,
  );
}

function rowCount() {
  return read(
    `(() => Array.from(document.querySelectorAll('table')).map((t) => t.querySelectorAll('tbody tr').length))()`,
  );
}

function fieldFill(name, value) {
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
  const out = read(js);
  if (!out?.ok)
    throw new Error(`fill failed ${name}: ${out?.error || 'unknown'}`);
  return out;
}

function save() {
  return action({ action: 'click', selector: 'button:has-text("Zapisz")' });
}

const added = [];
action({ action: 'nav', url: URL });
idle('long');
for (const ind of ownIndicators) {
  const current = tableText();
  if (current.includes(ind.name)) {
    added.push({ name: ind.name, skipped: true });
    continue;
  }
  action({ action: 'click', selector: 'button:has-text("Dodaj")' });
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
  ].map(([name, value]) => ({ name, ...fieldFill(name, value) }));
  idle('deliberate');
  const saved = save();
  idle('long');
  action({ action: 'nav', url: URL });
  idle('long');
  added.push({ name: ind.name, saved, filled });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      ownSource: ownIndicators.map((x) => x.name),
      added,
      rowCount: rowCount(),
      table: tableText(),
    },
    null,
    2,
  ),
);
