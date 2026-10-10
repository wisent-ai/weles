import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const WELES = new URL('../../../../..', import.meta.url).pathname.replace(
  /\/$/,
  '',
);
const SRC = (await import('#ncbr-settings')).applicationFile(
  'wersja_B_2.2_innowacyjnosc_i_zaleznosci.md',
);
const OUT = (await import('#ncbr-settings')).applicationFile(
  'sync_2_2_factor_rows_evidence_20260625.json',
);
const URL = (await import('#ncbr-settings')).sectionUrl('2_2');

const clean = (s) =>
  String(s || '')
    .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const md = readFileSync(SRC, 'utf8');

function parseRows() {
  const start = md.indexOf(
    '## Podsumowanie wpływu prac B+R na ograniczanie lub zwalczanie zależności Unii',
  );
  const end = md.indexOf('## Powiązanie rezultatu prac B+R', start);
  if (start < 0 || end < 0)
    throw new Error('2.2 factor table markers not found');
  return md
    .slice(start, end)
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
if (rows.length !== 5)
  throw new Error(`expected 5 factor rows, got ${rows.length}`);
if (process.env.ONLY) {
  const needle = process.env.ONLY.toLowerCase();
  rows = rows.filter((row) =>
    `${row.factor} ${row.param}`.toLowerCase().includes(needle),
  );
  if (rows.length === 0)
    throw new Error(`ONLY did not match any factor row: ${process.env.ONLY}`);
}

function action(args, optional = false) {
  const result = spawnSync(process.execPath, ['src/trajectories/_shared/keeper/action.mjs'], { cwd: WELES, env: { ...process.env, SESSION }, encoding: 'utf8', input: JSON.stringify(args) });
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
  if (!out) throw new Error(`empty keeper output for ${args.action}`);
  return JSON.parse(out);
}

function read(js) {
  return action({ action: 'eval', js: js }).result;
}

function idle(kind = 'short') {
  action({ action: 'settle' }, true);
}

function loginIfNeeded() {
  const url = action({ action: 'url' }, true);
  const current = url.ok === false ? '' : String(url.url || url.result || '');
  if (!/login|logowanie|auth/i.test(current)) return false;
  const email = process.env.NCBR_EMAIL;
  const password = process.env.NCBR_PASSWORD;
  if (!email || !password)
    throw new Error('login required but NCBR_EMAIL/NCBR_PASSWORD not set');
  action({ action: 'fill', selector: 'input#mail, input[name="mail"]', text: email });
  action({ action: 'fill', selector: 'input#password, input[name="password"]', text: password });
  action({ action: 'click', selector: 'input[name="isStatuteAccepted"]' }, true);
  action({ action: 'click', selector: 'button:has-text("Zaloguj się")' });
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
  if (!check?.ok)
    throw new Error(`fill precheck failed ${name}: ${JSON.stringify(check)}`);
  action({ action: 'fill', selector: `textarea[name="${name}"]:visible, input[name="${name}"]:visible`, text: value });
  idle('short');
  return read(`(() => {
    const name = ${JSON.stringify(name)};
    const el = Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null);
    return el ? { name, len: (el.value || '').length, max: Number(el.getAttribute('maxlength')) || null, tail: (el.value || '').slice(-80) } : { name, missing: true };
  })()`);
}

function openByParam(param) {
  // A row matches when one of its cells shows the parameter: the whole name,
  // or the start of it closed by the ellipsis the table draws when it cuts a
  // long name. How long a start the table shows is the table's own choice,
  // so no prefix length is chosen here.
  const idx = read(`(() => {
    const param = ${JSON.stringify(param.replace(/\s+/g, ' ').trim())};
    const trs = Array.from(document.querySelectorAll('table tbody tr'));
    return trs.findIndex((tr) => Array.from(tr.cells).some((td) => {
      const shown = td.innerText.replace(/\\s+/g, ' ').trim();
      if (shown === param) return true;
      const cut = shown.match(/^(.+?)\\s*(…|\\.\\.\\.)$/);
      return cut !== null && param.startsWith(cut[1]);
    }));
  })()`);
  if (idx < 0) throw new Error(`factor row not found by param: ${param}`);
  const menu = `:nth-match(table tbody tr, ${idx + 1}) button[aria-label="overflow-options"]`;
  action({ action: 'click', selector: menu });
  idle('short');
  action({ action: 'click', selector: 'text="Edytuj"' });
  idle('long');
  return { index: idx + 1 };
}

function saveSubform() {
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
      action({ action: 'click', selector: '#collection-obj-form-save-btn' }, true);
      clicks += 1;
    }
  }
}

function allRowsText() {
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t, ti) => ({
    table: ti,
    rows: Array.from(t.querySelectorAll('tbody tr')).map((tr, ri) => ({
      row: ri + 1,
      text: tr.innerText.replace(/\\s+/g, ' ')
    }))
  })))()`);
}

action({ action: 'nav', url: URL });
idle('long');
loginIfNeeded();
action({ action: 'nav', url: URL });
idle('long');

const before = allRowsText();
const synced = [];

for (const row of rows) {
  console.log(
    JSON.stringify({
      stage: 'open',
      param: row.param,
      methodLen: row.method.length,
      verifyLen: row.verify.length,
    }),
  );
  const opened = openByParam(row.param);
  const paramName = fill('nazwa_parametru', row.param);
  console.log(
    JSON.stringify({
      stage: 'filled-param',
      param: row.param,
      len: paramName.len,
      max: paramName.max,
    }),
  );
  const method = fill('metoda_szacowania_wartosci_docelowej', row.method);
  console.log(
    JSON.stringify({
      stage: 'filled-method',
      param: row.param,
      len: method.len,
      max: method.max,
    }),
  );
  const verify = fill(
    'sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych',
    row.verify,
  );
  console.log(
    JSON.stringify({
      stage: 'filled-verify',
      param: row.param,
      len: verify.len,
      max: verify.max,
    }),
  );
  action({ action: 'press', key: 'Tab' }, true);
  idle('long');
  saveSubform();
  console.log(JSON.stringify({ stage: 'saved', param: row.param }));
  synced.push({ param: row.param, opened, paramName, method, verify });
  action({ action: 'nav', url: URL });
  idle('long');
}

const after = allRowsText();
const evidence = {
  ok: true,
  url: URL,
  rows: rows.length,
  before,
  synced,
  after,
  finishedAt: new Date().toISOString(),
};
writeFileSync(OUT, JSON.stringify(evidence, null, 2));

console.log(
  JSON.stringify(
    {
      ok: true,
      out: OUT,
      rows: rows.length,
      lengths: synced.map((r) => ({
        param: r.param,
        paramName: `${r.paramName.len}/${r.paramName.max}`,
        method: `${r.method.len}/${r.method.max}`,
        verify: `${r.verify.len}/${r.verify.max}`,
      })),
    },
    null,
    2,
  ),
);
