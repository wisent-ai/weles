// UI-only keeper filler for 5.1 and 5.2 premium rows.
// Uses existing keeper session. Never submits.

import { spawnSync } from 'node:child_process';

const SESSION = process.env.SESSION || 'ncbr-step-b';
const WELES = new URL('../../../../..', import.meta.url).pathname.replace(
  /\/$/,
  '',
);
const PROJECT = (await import('#ncbr-settings')).sectionBase();
const SECTIONS = [
  ['5.1', (await import('#ncbr-settings')).sectionId('5_1')],
  ['5.2', (await import('#ncbr-settings')).sectionId('5_2')],
];

function action(args, optional = false) {
  const result = spawnSync(process.execPath, ['src/trajectories/_shared/keeper/action.mjs'], { cwd: WELES, env: { ...process.env, SESSION }, encoding: 'utf8', input: JSON.stringify(args) });
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

function tableRows() {
  return read(`(() => Array.from(document.querySelectorAll('table')).map((t) => ({
    rows: t.querySelectorAll('tbody tr').length,
    text: t.innerText.replace(/\\s+/g, ' ')
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
  action({ action: 'nav', url: `${PROJECT}${id}` });
  idle('long');
  let before = tableRows();
  if ((before[0]?.rows || 0) === 0) {
    action({ action: 'click', selector: 'button:has-text("Dodaj")' });
    idle('long');
    const applicant = openApplicant();
    idle('deliberate');
    const appClick = action({ action: 'click', selector: 'text="Wisent Polska"' }, true);
    idle('short');
    const radio = setRadioNie();
    idle('deliberate');
    const save = action({ action: 'click', selector: 'button:has-text("Zapisz")' }, true);
    idle('long');
    out.push({
      label,
      before,
      applicant,
      appClick,
      radio,
      save,
      after: tableRows(),
    });
  } else {
    out.push({ label, skipped: true, before });
  }
}

console.log(JSON.stringify({ ok: true, out }, null, 2));
