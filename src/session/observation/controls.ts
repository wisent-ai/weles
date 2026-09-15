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
  const describe = (el: Element, index: number): string => {
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
    return `[${index}] ${bits.join(' ')}`;
  };
  if (request.target !== undefined) {
    const index = request.index!;
    const element = elements[index];
    return element && describe(element, index) === request.target ? element : null;
  }
  return {
    title: document.title,
    text: document.body?.innerText.replace(/\s+/g, ' ').trim().slice(0, 4000),
    controls: elements.map(describe),
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
  const indexed = /^\[(\d+)\](?:\s|$)/.exec(target);
  if (!indexed) return null;
  const index = Number(indexed[1]);
  if (!Number.isSafeInteger(index)) throw new Error(`[observed_target_invalid] Invalid control index: ${target}`);
  const matches: ElementHandle[] = [];
  try {
    for (const frame of page.frames()) {
      // Bind the actual node in the same browser operation that checks its
      // description; a later DOM replacement cannot retarget this handle.
      const handle = await frame.evaluateHandle(captureFrame, { target, index });
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
