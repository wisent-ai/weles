/**
 * How we reach an element when an ordinary human click cannot: pointer focus
 * by guessed selector, a direct selector click, the literal-input guard and
 * page scrolling. The last-resort JS click is page-actions/js-click.ts and
 * the untrusted control setter page-actions/set-control.ts. Each function is
 * the body of the identically named WSession method and keeps its runStep
 * label, so step numbering and artifact names are unchanged.
 */

import { humanClickLocator } from '../../human/mouse.js';
import { humanType } from '../../human/keyboard.js';
import { selectOption } from '../../human/select.js';
import type { WSession } from '../wsession.js';
import { assertNonCredentialInput } from '../../utils/capability.js';
import {
  assertLiteralControl,
} from '../wsession-helpers/close/credential_field/index.js';

// WSession imports every action from this module.
export { wsJsClick } from './page-actions/js-click.js';
export { wsSetControl } from './page-actions/set-control.js';

/** Refuses literal input when the focused field, followed into the frames
 * that hold it, is one whose markup declares a credential class. */
export async function assertFocusedLiteralInput(s: WSession): Promise<void> {
  let frame = s.page.mainFrame();
  while (frame) {
    const handle = await frame.evaluateHandle(() => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement)
        active = active.shadowRoot.activeElement;
      return active;
    });
    try {
      const element = handle.asElement();
      if (!element)
        throw new Error('literal input requires an observable focused element');
      const child = await element.contentFrame();
      if (child) {
        frame = child;
        continue;
      }
      await assertLiteralControl(element);
      return;
    } finally {
      await handle.dispose();
    }
  }
  throw new Error('literal input requires an observable focused frame');
}

/** The selectors a field named by `selector` is looked for under, as written first. */
function focusCandidates(selector: string): string[] {
  const candidates = [
    selector,
    `input[name="${selector}"]`,
    `input[type="${selector}"]`,
    `input[placeholder*="${selector}" i]`,
  ];
  // The last word of a compound selector, unquoted, is also tried as a name.
  const last = selector.split(' ').pop();
  const simple = last ? last.toLowerCase().replace(/['"[\]]/g, '') : '';
  if (simple && simple !== selector)
    candidates.push(
      `input[name="${simple}"]`,
      `input[placeholder*="${simple}" i]`,
    );
  return candidates;
}

export async function wsFocus(s: WSession, selector: string): Promise<string> {
  return s.runStep(`focus_${selector}`, async () => {
    for (const candidate of focusCandidates(selector)) {
      const loc = s.page.locator(candidate).first();
      let count: number;
      try {
        count = await loc.count();
      } catch (error) {
        // A candidate that is not valid CSS is passed over, and said.
        console.log(
          `[focus] ${candidate} is not a usable selector: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!count) continue;
      await humanClickLocator(s.page, loc);
      return `focused: ${candidate}`;
    }
    return 'no-element-found';
  });
}

export async function wsClickSelector(
  s: WSession,
  selector: string,
): Promise<string> {
  return s.runStep(`clickSel_${selector}`, async () => {
    const loc = s.page.locator(selector).first();
    if (!(await loc.count())) return 'no-element-found';
    await humanClickLocator(s.page, loc);
    return `clicked ${selector}`;
  });
}

// Without a stated amount a scroll moves one viewport, measured on the page.
export async function wsScroll(
  s: WSession,
  direction: string,
  amount?: number,
): Promise<string> {
  return s.runStep(`scroll_${direction}`, async () => {
    const moved = await s.page.evaluate(
      ({ up, stated }: { up: boolean; stated: number | undefined }) => {
        const step = stated === undefined ? window.innerHeight : stated;
        window.scrollBy({ top: up ? -step : step });
        return step;
      },
      { up: direction === 'up', stated: amount },
    );
    return `scrolled ${direction} ${moved}`;
  });
}

/** Type `value` into the focused field, which must be one a literal may go into. */
export async function wsType(s: WSession, value: string): Promise<string> {
  const literal = assertNonCredentialInput(value);
  return s.runStep('type', async () => {
    await assertFocusedLiteralInput(s);
    await humanType(s.page, literal);
    return 'typed';
  });
}

export async function wsPress(s: WSession, key: string): Promise<string> {
  return s.runStep(`press_${key}`, async () => {
    await s.page.keyboard.press(key);
    return `pressed ${key}`;
  });
}

/** Choose `value` in the combobox named `target`; a step that cannot is refused with what the page offered. */
export async function wsSelect(
  s: WSession,
  target: string,
  value: string,
): Promise<string> {
  return s.runStep(`select_${target}_${value}`, async () => {
    const chosen = await selectOption(s.page, target, s.resolveEnv(value));
    return `selected: ${chosen}`;
  });
}
