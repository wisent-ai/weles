/**
 * The untrusted control setter, for form widgets that ignore synthetic
 * typing: a select is matched by option text or value, a checkbox or radio
 * takes the checked state asked for, and any other input gets its value
 * through the element's own setter so frameworks see the change. The step
 * answers what the control holds afterwards and the validation the page
 * shows beside it.
 */

import type { Frame } from 'playwright';
import { assertNonCredentialInput } from '../../../utils/capability.js';
import { assertLiteralControl } from '../../wsession-helpers/close/credential_field/index.js';
import type { WSession } from '../../wsession.js';

/** Selectors of the messages a form shows beside an invalid field. */
const VALIDATION_MESSAGES =
  '.hs-error-msg, .hs-error-msgs label, [role="alert"], .error, .invalid, .field-error';

type SetArgs = {
  value: string | undefined;
  checked: boolean | undefined;
  validation: string;
};

type ControlState = {
  tag: string;
  type: string;
  name: string;
  valuePresent: boolean;
  valueLength?: number;
  selectedText?: string;
  checked?: boolean;
  validation: string[];
};

/** Runs on the control: set it, fire its events, and read what it holds now. */
function setInPage(element: Element, args: SetArgs): ControlState {
  const { value, checked, validation } = args;
  const el = element as HTMLInputElement | HTMLTextAreaElement;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const tag = el.tagName.toLowerCase();
  const fire = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };
  if (element instanceof HTMLSelectElement) {
    if (value !== undefined) {
      const wanted = value.toLowerCase();
      const option = Array.from(element.options).find((candidate) => {
        const text = candidate.text.toLowerCase();
        const optionValue = candidate.value.toLowerCase();
        return (
          text === wanted ||
          optionValue === wanted ||
          text.includes(wanted) ||
          optionValue.includes(wanted)
        );
      });
      element.value = option ? option.value : value;
    }
    fire();
  } else if (checked !== undefined && element instanceof HTMLInputElement) {
    // The caller asked for a checked state, so that is what is set.
    element.checked = checked;
    fire();
  } else if (value !== undefined) {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    fire();
  }
  const shown = Array.from(document.querySelectorAll(validation))
    .map((node) => (node.textContent ? node.textContent : ''))
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const state: ControlState = {
    tag,
    type: element instanceof HTMLInputElement ? element.type : tag,
    name: el.name,
    valuePresent: Boolean(el.value),
    validation: shown,
  };
  if ('value' in el) state.valueLength = String(el.value).length;
  if (element instanceof HTMLSelectElement) {
    const [selected] = Array.from(element.selectedOptions);
    if (selected) state.selectedText = selected.text;
  }
  if (element instanceof HTMLInputElement) state.checked = element.checked;
  return state;
}

/** Set the control `selector` names in `frame`; nothing when the frame holds none. */
async function setInFrame(
  frame: Frame,
  selector: string,
  args: SetArgs,
): Promise<string | null> {
  const handle = await frame.evaluateHandle(
    (target: string) => document.querySelector(target),
    selector,
  );
  try {
    const control = handle.asElement();
    if (!control) return null;
    if (args.value !== undefined) await assertLiteralControl(control);
    let state: ControlState | { error: string };
    try {
      state = await control.evaluate(setInPage, args);
    } catch (error) {
      state = { error: error instanceof Error ? error.message : String(error) };
    }
    return `set_control ${JSON.stringify(state)}`;
  } finally {
    await handle.dispose();
  }
}

/**
 * The value the caller stated, as text: a string may name no environment
 * variable; no value means the control's value is left as it is. Whether the
 * control may take it is its markup's answer (`setInFrame`).
 */
function statedValue(value: unknown): string | undefined {
  if (typeof value === 'string') return assertNonCredentialInput(value);
  if (value === undefined || value === null) return undefined;
  return String(value);
}

export async function wsSetControl(
  s: WSession,
  selector: string,
  value?: unknown,
  checked?: unknown,
): Promise<string> {
  return s.runStep(`setControl_${selector}`, async () => {
    if (!selector.trim()) return 'no-selector';
    const args: SetArgs = {
      value: statedValue(value),
      checked: typeof checked === 'boolean' ? checked : undefined,
      validation: VALIDATION_MESSAGES,
    };
    // The main frame first, then each child frame once.
    const main = s.page.mainFrame();
    const children = s.page.frames().filter((f: Frame) => f !== main);
    const frames: Frame[] = [main, ...children];
    for (const frame of frames) {
      const answer = await setInFrame(frame, selector, args);
      if (answer) return answer;
    }
    return 'no-element-found';
  });
}
