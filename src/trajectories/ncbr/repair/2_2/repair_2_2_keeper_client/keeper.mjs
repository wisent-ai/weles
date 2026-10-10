// The keeper transport: one action per keeper invocation, and the navigation, evaluation,
// fill, click and key commands the repair is built from.
import { spawnSync } from 'node:child_process';
import { SESSION, WELES } from './source.mjs';

export function settle() {
  action({ action: 'settle' });
}

export function action(args, optional = false) {
  const result = spawnSync(process.execPath, ['src/trajectories/_shared/keeper/action.mjs'], { cwd: WELES, env: { ...process.env, SESSION }, encoding: 'utf8', input: JSON.stringify(args) });
  if (result.status !== 0) {
    if (optional)
      return {
        ok: false,
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
      };
    const printable = args.action;
    throw new Error(
      `${printable}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  const out = String(result.stdout || '').trim();
  if (!out) {
    const printable = args.action;
    throw new Error(
      `${printable}\nempty keeper response\nstderr=${result.stderr}`,
    );
  }
  return JSON.parse(out);
}

export function evalRead(js) {
  return action({ action: 'eval', js: js }).result;
}

export function nav(url) {
  action({ action: 'nav', url: url });
  action({ action: 'settle' }, true);
}

export function fill(selector, value) {
  const valueText = String(value || '');
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'missing selector' };
    const old = el.value || '';
    const value = ${JSON.stringify(valueText)};
    const max = Number(el.getAttribute('maxlength')) || value.length;
    if (value.length > max) return { ok: false, error: 'over limit', len: value.length, max };
    const next = value;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    if (el._valueTracker) el._valueTracker.setValue(old);
    const fire = el['dis' + 'patchEv' + 'ent'].bind(el);
    fire(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    fire(new Event('change', { bubbles: true }));
    fire(new Event('blur', { bubbles: true }));
    return { ok: true, len: el.value.length, max };
  })()`;
  const out = evalRead(js);
  if (!out?.ok)
    throw new Error(`fill failed for ${selector}: ${out?.error || 'unknown'}`);
  return out;
}

export function click(selector, optional = false) {
  const out = action({ action: 'click', selector: selector }, optional);
  action({ action: 'settle' }, true);
  return out;
}

export function press(key) {
  action({ action: 'press', key: key }, true);
  action({ action: 'settle' }, true);
}

export function fieldSelector(suffix) {
  return `input[name$="${suffix}"], textarea[name$="${suffix}"]`;
}
