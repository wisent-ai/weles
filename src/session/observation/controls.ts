import type { ElementHandle, Frame, Page } from 'playwright';
import { humanClickLocator } from '../../human/mouse.js';

export interface FrameObservation {
  title?: string;
  text?: string;
  controls?: string[];
  error?: string;
}

// The same browser-side description both produces an observation and resolves
// its target. A numeric position alone is never authority to click an element.
function captureFrame(request: { target?: string; index?: number }): FrameObservation | Element | null {
  const elements = Array.from(document.querySelectorAll('input, textarea, select, button, a, [role="button"], [role="link"]'))
    .slice(0, 80);
  const describe = (el: Element): string => {
    const control = el as HTMLElement & { value?: string; type?: string; name?: string; href?: string; checked?: boolean; selectedOptions?: HTMLCollectionOf<HTMLOptionElement> };
    let label = control.getAttribute('aria-label');
    if (!label) label = control.getAttribute('placeholder');
    if (!label) label = control.innerText;
    if (!label) label = control.getAttribute('title');
    const type = control.type;
    const name = control.name;
    const value = typeof control.value === 'string' ? control.value.replace(/\s+/g, ' ').trim() : undefined;
    const sensitive = /password|token|key|secret|email|captcha|cookie|authorization/i.test(`${type} ${name} ${label}`);
    const selected = control.selectedOptions?.[0]?.text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const valueState = value ? (sensitive || !selected ? `[set len=${value.length}]` : selected) : undefined;
    const role = control.getAttribute('role');
    const normalizedLabel = label?.replace(/\s+/g, ' ').trim().slice(0, 120);
    const bits = [
      control.tagName.toLowerCase(), role && `role=${role}`, name && `name=${name}`,
      type && `type=${type}`, normalizedLabel && `label=${normalizedLabel}`,
      valueState && `value=${valueState}`, typeof control.checked === 'boolean' && `checked=${control.checked}`,
      control.href && `href=${control.href}`,
    ].filter(Boolean);
    return bits.join(' ');
  };
  if (request.target !== undefined) {
    if (request.index !== undefined) {
      const element = elements[request.index];
      return element && describe(element) === request.target ? element : null;
    }
    let match: Element | null = null;
    for (const element of elements) {
      if (describe(element) !== request.target) continue;
      if (match) throw new Error(`[observed_target_ambiguous] Multiple controls share this description; include the observed index: ${request.target}`);
      match = element;
    }
    return match;
  }
  return {
    title: document.title,
    text: document.body?.innerText.replace(/\s+/g, ' ').trim().slice(0, 4000),
    controls: elements.map((element, index) => `[${index}] ${describe(element)}`),
  };
}

export async function readFrameObservation(frame: Pick<Frame, 'evaluate'>): Promise<FrameObservation> {
  try {
    return await frame.evaluate(captureFrame, {}) as FrameObservation;
  } catch (error: any) {
    return { error: String(error.message ?? error).slice(0, 160) };
  }
}

export async function clickObservedControl(page: Page, description: string): Promise<string | null> {
  const target = description.trim();
  const indexed = /^\[(\d+)\]\s*/.exec(target);
  const control = indexed ? target.slice(indexed[0].length) : target;
  if (!indexed && !/^[a-z][a-z0-9-]* (?:role|name|type|label|value|checked|href)=/.test(control)) return null;
  const index = indexed ? Number(indexed[1]) : undefined;
  if (index !== undefined && !Number.isSafeInteger(index)) throw new Error(`[observed_target_invalid] Invalid control index: ${target}`);
  const matches: ElementHandle[] = [];
  try {
    for (const frame of page.frames()) {
      // Bind the actual node in the same browser operation that checks its
      // description; a later DOM replacement cannot retarget this handle.
      const handle = await frame.evaluateHandle(captureFrame, { target: control, index });
      const element = handle.asElement();
      if (element) matches.push(element);
      else await handle.dispose();
    }
    if (matches.length === 0) throw new Error(`[observed_target_stale] The control is stale or absent; observe again: ${target}`);
    if (matches.length !== 1) throw new Error(`[observed_target_ambiguous] The control matches multiple frames; use a frame-specific description: ${target}`);
    await humanClickLocator(page, matches[0]);
    return `clicked observed control: ${target}`;
  } finally {
    await Promise.all(matches.map(element => element.dispose()));
  }
}

export async function clickSelectorControl(page: Page, description: string): Promise<string | null> {
  const target = description.trim();
  const labelledButton = /^button\[label=(['"])(.*?)\1\]$/.exec(target);
  const selectorSyntax = /^(?:css=|xpath=|text=|id=|[.#\[]|[a-z][\w-]*[.#\[:]|(?:a|button|input|label|select|textarea)$)/i;
  if (!labelledButton && !selectorSyntax.test(target)) return null;
  const label = labelledButton
    ? new RegExp(`^\\s*${labelledButton[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
    : null;
  const handles: ElementHandle[] = [];
  try {
    for (const frame of page.frames()) {
      const locator = label ? frame.getByRole('button', { name: label }) : frame.locator(target);
      try {
        handles.push(...await locator.elementHandles());
      } catch (error) {
        throw new Error(`[selector_target_invalid] Cannot resolve ${target}: ${String(error)}; no pointer input was sent`);
      }
    }
    let match: ElementHandle | undefined;
    for (const handle of handles) {
      if (!await handle.isVisible()) continue;
      if (match) throw new Error(`[selector_target_ambiguous] Multiple visible controls match ${target}; no pointer input was sent`);
      match = handle;
    }
    if (!match) throw new Error(`[selector_target_absent] No visible control matches ${target}; no pointer input was sent. Use a current observed control or a correct selector`);
    await humanClickLocator(page, match);
    return `clicked selector: ${target}`;
  } finally {
    await Promise.all(handles.map(handle => handle.dispose()));
  }
}
