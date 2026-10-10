import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { shows } from '../../../_shared/page/shows.mjs';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const WELES = new URL('../../../../..', import.meta.url).pathname.replace(
  /\/$/,
  '',
);
const SRC = (await import('#ncbr-settings')).applicationFile(
  'wersja_B_2.4_efekty_zewnetrzne.md',
);
const OUT = (await import('#ncbr-settings')).applicationFile(
  'sync_2_4_params_evidence_20260625.json',
);
const URL = (await import('#ncbr-settings')).sectionUrl('2_4');

const clean = (s) =>
  String(s || '')
    .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const md = readFileSync(SRC, 'utf8');

function rowValue(block, label) {
  const line = block
    .split(/\r?\n/)
    .find(
      (l) => l.startsWith('|') && l.toLowerCase().includes(label.toLowerCase()),
    );
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
  return md
    .slice(start + title.length)
    .split(/^### Parametr \d+\s*$/m)
    .slice(1)
    .map((block, index) => ({
      match: oldMatches[index],
      name: rowValue(block, 'Nazwa parametru'),
      method: rowValue(block, 'Metoda oszacowania'),
      verify: rowValue(block, 'Sposób monitorowania'),
    }));
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

const read = (js) => action({ action: 'eval', js: js }).result;
const idle = (kind = 'short') => action({ action: 'settle' }, true);

function fill(name, value) {
  const check = read(`(() => {
    const name = ${JSON.stringify(name)};
    const value = ${JSON.stringify(value)};
    const el = Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null);
    if (!el) return { ok: false, error: 'missing', name };
    const max = Number(el.getAttribute('maxlength')) || value.length;
    return { ok: value.length <= max, tag: el.tagName.toLowerCase(), name, len: value.length, max, currentLen: (el.value || '').length };
  })()`);
  if (!check?.ok)
    throw new Error(`fill precheck failed ${name}: ${JSON.stringify(check)}`);
  action({ action: 'fill', selector: `${check.tag}[name="${name}"]`, text: value });
  idle('short');
  return read(`(() => {
    const name = ${JSON.stringify(name)};
    const el = Array.from(document.querySelectorAll('textarea[name="' + CSS.escape(name) + '"], input[name="' + CSS.escape(name) + '"]')).find((e) => e.offsetParent !== null);
    return el ? { name, len: (el.value || '').length, max: Number(el.getAttribute('maxlength')) || null } : { name, missing: true };
  })()`);
}

function openByNeedle(needles) {
  const needleList = Array.isArray(needles) ? needles : [needles];
  // A row matches when one of its cells shows a needle whole or by its
  // ellipsis-closed start (shows.mjs); no prefix length is chosen here.
  const idx = read(`(() => {
    const shows = ${shows.toString()};
    const needles = ${JSON.stringify(needleList)};
    const trs = Array.from(document.querySelectorAll('table tbody tr'));
    return trs.findIndex((tr) => Array.from(tr.cells).some((td) => needles.some((needle) => shows(td.innerText, needle))));
  })()`);
  if (idx < 0) throw new Error(`row not found by text: ${needleList[0]}`);
  const menuSelector = `:nth-match(table tbody tr, ${idx + 1}) button[aria-label="overflow-options"]`;
  action({ action: 'click', selector: menuSelector });
  idle();
  const openedMenu = read(
    `(() => Array.from(document.querySelectorAll('[role="menuitem"], li, button')).some((el) => el.offsetParent !== null && el.innerText.trim() === 'Edytuj'))()`,
  );
  if (!openedMenu)
    throw new Error(`edit menu did not open for row: ${needleList[0]}`);
  action({ action: 'click', selector: 'text="Edytuj"' });
  idle('long');
  return { index: idx + 1 };
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
      action({ action: 'click', selector: '#collection-obj-form-save-btn' }, true);
      clicks += 1;
    }
  }
}

action({ action: 'nav', url: URL });
idle('long');

const synced = [];
for (const row of rows()) {
  console.log(JSON.stringify({ stage: 'open', needle: row.match }));
  const opened = openByNeedle([row.match, row.name]);
  const fills = [
    fill('nazwa_parametru', row.name),
    fill('metoda_szacowania_wartosci_docelowej', row.method),
    fill(
      'sposob_monitorowania_weryfikacji_osiagniecia_zaplanowanych_wartosci_docelowych',
      row.verify,
    ),
  ];
  console.log(
    JSON.stringify({
      stage: 'filled',
      needle: row.match,
      lengths: fills.map((f) => `${f.name}:${f.len}/${f.max}`),
    }),
  );
  const save = saveSubform();
  console.log(JSON.stringify({ stage: 'saved', needle: row.match, save }));
  synced.push({ needle: row.match, opened, fills, save });
  action({ action: 'nav', url: URL });
  idle('long');
}

const evidence = {
  ok: true,
  rows: synced.length,
  synced,
  finishedAt: new Date().toISOString(),
};
writeFileSync(OUT, JSON.stringify(evidence, null, 2));
console.log(
  JSON.stringify(
    {
      ok: true,
      out: OUT,
      rows: synced.length,
      lengths: synced.map((r) => ({
        needle: r.needle,
        fields: r.fills.map((f) => `${f.name}:${f.len}/${f.max}`),
      })),
    },
    null,
    2,
  ),
);
