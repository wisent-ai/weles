import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent';
const WELES = `${ROOT}/weles`;
const BACKENDS = `${ROOT}/backends`;
const SRC = `${BACKENDS}/STEP_sciezka_A_Wisent/wersja_B_2.4_efekty_zewnetrzne.md`;
const OUT = `${BACKENDS}/STEP_sciezka_A_Wisent/sync_2_4_params_evidence_20260625.json`;
const URL = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/94fb1adb-38a5-4949-b4c1-b0a79472bfd3';

const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim();
const md = readFileSync(SRC, 'utf8');

function rowValue(block, label) {
  const line = block.split(/\r?\n/).find((l) => l.startsWith('|') && l.toLowerCase().includes(label.toLowerCase()));
  if (!line) throw new Error(`row missing: ${label}`);
  return clean(line.split('|').slice(1, -1)[1]);
}

function rows() {
  const title = '## Parametry opisujące dodatkowe efekty zewnętrzne innowacji';
  const start = md.indexOf(title);
  if (start < 0) throw new Error('section missing');
  const oldMatches = [
    'Skumulowana liczba unikniętych pełnych cykli dotrenowywania modeli u odbiorców w UE dzięki adaptacji przez edycję reprezentacji',
    'Udział odpowiedzi modelu produkcyjnego RNM opatrzonych konstrukcyjnym raportem audytowym wskazującym aktywne koncepty',
    'Liczba urzędowych języków UE obsługiwanych przez RNM powyżej progu jakości generacji',
    'Liczba wdrożeń RNM w sektorach regulowanych UE korzystających z raportu audytowego aktywnych konceptów',
    'Udział głównych cykli treningowych RNM objętych pomiarem energii, CO2eq i kryteriami zielonych zamówień',
  ];
  return md.slice(start + title.length)
    .split(/^### Parametr \d+\s*$/m)
    .slice(1)
    .map((block, index) => ({
      match: oldMatches[index],
      name: rowValue(block, 'Nazwa parametru'),
      method: rowValue(block, 'Metoda oszacowania'),
      verify: rowValue(block, 'Sposób monitorowania'),
    }));
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

const read = (js) => action(['eval', js], 120000).result;
const idle = (kind = 'short') => action(['humanidle', kind], 60000, true);

function fill(name, value) {
  const check = read(`(() => {
    const name = ${JSON.stringify(name)};
    const value = ${JSON.stringify(value)};
    const el = Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null);
    if (!el) return { ok: false, error: 'missing', name };
    const max = Number(el.getAttribute('maxlength')) || value.length;
    return { ok: value.length <= max, tag: el.tagName.toLowerCase(), name, len: value.length, max, currentLen: (el.value || '').length };
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

function openByNeedle(needles) {
  const needleList = Array.isArray(needles) ? needles : [needles];
  const idx = read(`(() => {
    const needles = ${JSON.stringify(needleList.map((n) => n.slice(0, 90)))};
    const trs = Array.from(document.querySelectorAll('table tbody tr'));
    return trs.findIndex((tr) => needles.some((needle) => tr.innerText.replace(/\\s+/g, ' ').includes(needle)));
  })()`);
  if (idx < 0) throw new Error(`row not found by text: ${needleList[0]}`);
  const menuSelector = `:nth-match(table tbody tr, ${idx + 1}) button[aria-label="overflow-options"]`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    action([attempt === 0 ? 'click_fast' : 'dispatch_click', menuSelector], 90000, true);
    idle('short');
    const hasEdit = read(`(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).some((el) => el.offsetParent !== null && el.innerText.trim() === 'Edytuj'))()`);
    if (hasEdit) break;
  }
  const openedMenu = read(`(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).some((el) => el.offsetParent !== null && el.innerText.trim() === 'Edytuj'))()`);
  if (!openedMenu) throw new Error(`edit menu did not open for row: ${needleList[0]}`);
  action(['dispatch_click', 'text="Edytuj"'], 60000);
  idle('long');
  return { index: idx + 1 };
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
for (const row of rows()) {
  console.log(JSON.stringify({ stage: 'open', needle: row.match }));
  const opened = openByNeedle([row.match, row.name]);
  const fills = [
    fill('nazwa_parametru', row.name),
    fill('metoda_szacowania_wartosci_docelowej', row.method),
    fill('sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych', row.verify),
  ];
  console.log(JSON.stringify({ stage: 'filled', needle: row.match, lengths: fills.map((f) => `${f.name}:${f.len}/${f.max}`) }));
  const save = saveSubform();
  console.log(JSON.stringify({ stage: 'saved', needle: row.match, save }));
  synced.push({ needle: row.match, opened, fills, save });
  action(['nav', URL], 180000);
  idle('long');
}

const evidence = { ok: true, rows: synced.length, synced, finishedAt: new Date().toISOString() };
writeFileSync(OUT, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, out: OUT, rows: synced.length, lengths: synced.map((r) => ({ needle: r.needle, fields: r.fills.map((f) => `${f.name}:${f.len}/${f.max}`) })) }, null, 2));
