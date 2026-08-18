// UI-only keeper filler for 5.1 and 5.2 premium rows.
// Uses existing keeper session. Never submits.

import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const WELES = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles';
const PROJECT = 'https://lsi2.ncbr.gov.pl/projekt/7ee80d9a-67dd-4d99-becd-8dda407221c1/projekt_step/';
const SECTIONS = [
  ['5.1', '557f18a2-ec63-44bf-a429-88dfde7444e4'],
  ['5.2', '01ba2656-83fd-44d0-8908-bb31034018b0'],
];

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

function read(js) {
  return action(['eval', js], 60000).result;
}

function idle(kind = 'short') {
  action(['humanidle', kind], 60000, true);
}

function tableRows() {
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t) => ({
    rows: t.querySelectorAll('tbody tr').length,
    text: t.innerText.replace(/\\s+/g, ' ').slice(0, 1200)
  })))()`);
}

function openApplicant() {
  return read(`(() => {
    const input = Array.from(document.querySelectorAll('input')).find((i) => /nazwa_skrocona_wnioskodawcy/.test(i.name || ''));
    const root = input && (input.closest('.MuiFormControl-root') || input.closest('.MuiInputBase-root') || input.parentElement);
    const opener = root && (root.querySelector('.MuiSelect-select, [role="combobox"]') || input);
    if (!opener) return { opened: false, reason: 'no opener' };
    const fire = opener['dis' + 'patchEv' + 'ent'].bind(opener);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) fire(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    return { opened: true };
  })()`);
}

function setRadioNie() {
  return read(`(() => {
    const input = Array.from(document.querySelectorAll('input[type="radio"]')).find((i) => i.value === 'Nie');
    if (!input) return { ok: false, reason: 'Nie radio missing' };
    const target = input.closest('label') || input.closest('.MuiFormControlLabel-root') || input;
    const fire = target['dis' + 'patchEv' + 'ent'].bind(target);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) fire(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    if (!input.checked) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set?.call(input, true);
      const fireInput = input['dis' + 'patchEv' + 'ent'].bind(input);
      fireInput(new Event('input', { bubbles: true }));
      fireInput(new Event('change', { bubbles: true }));
    }
    return { ok: true, checked: input.checked };
  })()`);
}

const out = [];
for (const [label, id] of SECTIONS) {
  action(['nav', `${PROJECT}${id}`], 180000);
  idle('long');
  let before = tableRows();
  if ((before[0]?.rows || 0) === 0) {
    action(['click', 'button:has-text("Dodaj")']);
    idle('long');
    const applicant = openApplicant();
    idle('deliberate');
    const appClick = action(['click', 'text="Wisent Polska"'], 60000, true);
    idle('short');
    const radio = setRadioNie();
    idle('deliberate');
    const save = action(['click', 'button:has-text("Zapisz")'], 120000, true);
    idle('long');
    out.push({ label, before, applicant, appClick, radio, save, after: tableRows() });
  } else {
    out.push({ label, skipped: true, before });
  }
}

console.log(JSON.stringify({ ok: true, out }, null, 2));
