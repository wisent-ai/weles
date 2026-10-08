/**
 * How we reach an element when an ordinary human click cannot: pointer focus
 * by guessed selector, the last-resort JS click that walks shadow roots and
 * child frames, a direct selector click, the untrusted control setter used for
 * form widgets that ignore synthetic typing, and page scrolling.
 *
 * Extracted from wsession.ts (focus, jsClick, clickSelector, setControl,
 * scroll) to keep the class file under its 300-line cap. Each function is the
 * body of the identically named WSession method and keeps its runStep label,
 * so step numbering and artifact names are unchanged.
 */

import { humanClick, humanClickLocator } from '../../human/mouse.js';
import type { WSession } from '../wsession.js';
import { assertNonCredentialInput } from '../../utils/capability.js';
import { describeInputTarget } from '../observation/controls.js';

export async function assertFocusedLiteralInput(
  s: WSession,
  value: string,
): Promise<void> {
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
      assertNonCredentialInput(
        value,
        await element.evaluate(describeInputTarget),
      );
      return;
    } finally {
      await handle.dispose();
    }
  }
  throw new Error('literal input requires an observable focused frame');
}

export async function wsFocus(s: WSession, selector: string): Promise<string> {
  return s.runStep(`focus_${selector}`, async () => {
    const simple =
      selector
        .split(' ')
        .pop()
        ?.toLowerCase()
        .replace(/['"[\]]/g, '') ?? '';
    const sels = [
      selector,
      `input[name="${selector}"]`,
      `input[type="${selector}"]`,
      `input[placeholder*="${selector}" i]`,
    ];
    if (simple && simple !== selector)
      sels.push(`input[name="${simple}"]`, `input[placeholder*="${simple}" i]`);
    for (const candidate of sels) {
      try {
        const b = await s.page.locator?.(candidate)?.first?.()?.boundingBox?.();
        if (b) {
          await humanClick(s.page, b.x + b.width / 2, b.y + b.height / 2);
          return `focused: ${candidate}`;
        }
      } catch {}
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

export async function wsJsClick(
  s: WSession,
  selector?: string,
  text?: string,
): Promise<string> {
  return s.runStep(`jsClick_${text ?? selector}`, async () => {
    // An absent text reads as `undefined` in the page script, which its own
    // `t&&` checks skip.
    const txt = JSON.stringify(text?.toLowerCase());
    const sr = await s.page.evaluate(
      `(()=>{var t=${txt};function F(r){var a=[];r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot){var sr=e.shadowRoot;a=a.concat(Array.from(sr.querySelectorAll('[data-post-click-location] button')));a=a.concat(F(sr))}});return a}var bs=F(document);if(t&&t.indexOf('upvote')>=0&&bs.length>0){bs[0].click();return'clicked upvote (shadow)'}if(t&&t.indexOf('downvote')>=0&&bs.length>1){bs[1].click();return'clicked downvote (shadow)'}return null})()`,
    );
    if (sr) return sr;
    for (const frame of s.page.frames?.() ?? []) {
      if (frame === s.page.mainFrame?.()) continue;
      if (selector) {
        try {
          const loc = frame.locator(selector).first();
          if (await loc.count()) {
            await loc.click();
            return `clicked frame: ${selector}`;
          }
        } catch {
          /* try frame eval */
        }
      }
      if (text) {
        try {
          const loc = frame.getByText(new RegExp(text, 'i')).first();
          if (
            (await loc.count()) &&
            (await loc.isVisible().catch(() => false))
          ) {
            await humanClickLocator(s.page, loc);
            return `clicked frame text: ${text}`;
          }
        } catch {
          /* try frame eval */
        }
      }
      // The frame's own search, as a typed function: an element by selector,
      // else the first control whose text, label or name holds the wanted
      // text; a label also fires its input. The clicked control is named by
      // its whole text.
      const frameHit = await frame.evaluate(
        ({ selector, wanted }: { selector?: string; wanted?: string }) => {
          const all = (root: any, css: string): any[] => {
            let found: any[] = Array.from(root.querySelectorAll(css));
            root.querySelectorAll('*').forEach((el: any) => {
              if (el.shadowRoot) found = found.concat(all(el.shadowRoot, css));
            });
            return found;
          };
          const fire = (el: any) => {
            el.click();
            if (
              el instanceof HTMLInputElement &&
              (el.type === 'checkbox' || el.type === 'radio')
            ) {
              el.checked = true;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          };
          if (selector) {
            const [el] = all(document, selector);
            if (el) {
              fire(el);
              return `clicked-frame-untrusted: ${selector}`;
            }
          }
          if (!wanted) return null;
          for (const el of all(
            document,
            'label,button,a,[role="button"],[role="checkbox"],[role="radio"],input[type="checkbox"],input[type="radio"]',
          )) {
            const label = [
              el.textContent,
              el.getAttribute('aria-label'),
              el.getAttribute('name'),
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();
            if (!label.includes(wanted)) continue;
            fire(el);
            const forId = el.getAttribute('for');
            const input = forId ? document.getElementById(forId) : null;
            if (input) fire(input);
            return `clicked-frame-untrusted: ${label.trim()}`;
          }
          return null;
        },
        { selector, wanted: text?.toLowerCase() },
      );
      if (frameHit) return frameHit;
    }
    if (selector) {
      try {
        const loc = s.page.locator(selector).first();
        if (await loc.count()) {
          await loc.click();
          return `clicked: ${selector}`;
        }
      } catch {
        /* try eval */
      }
    }
    if (text) {
      try {
        const loc = s.page
          .getByRole('button', { name: new RegExp(text, 'i') })
          .first();
        if (await loc.count()) {
          await loc.click();
          return `clicked text: ${text}`;
        }
      } catch {
        /* try eval */
      }
    }
    // The page's own search, as a typed function: an element by selector,
    // else the first control whose text or label holds the wanted text,
    // named by its whole text.
    const r = await s.page.evaluate(
      ({ selector, wanted }: { selector?: string; wanted?: string }) => {
        const all = (root: any, css: string): any[] => {
          let found: any[] = Array.from(root.querySelectorAll(css));
          root.querySelectorAll('*').forEach((el: any) => {
            if (el.shadowRoot) found = found.concat(all(el.shadowRoot, css));
          });
          return found;
        };
        if (selector) {
          const [el] = all(document, selector);
          if (el) {
            el.click();
            return `clicked-untrusted: ${selector}`;
          }
        }
        if (!wanted) return null;
        for (const el of all(
          document,
          'button,a,[role="button"],[class*="vote"],[class*="like"],[class*="star"],[class*="follow"]',
        )) {
          const label = [el.textContent, el.getAttribute('aria-label')]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!label.includes(wanted)) continue;
          el.click();
          return `clicked-untrusted: ${label.trim()}`;
        }
        return null;
      },
      { selector, wanted: text?.toLowerCase() },
    );
    return r ?? 'no-element-found';
  });
}

export async function wsSetControl(
  s: WSession,
  selector: string,
  value?: unknown,
  checked?: unknown,
): Promise<string> {
  return s.runStep(`setControl_${selector}`, async () => {
    if (!selector.trim()) return 'no-selector';
    const resolvedValue =
      typeof value === 'string'
        ? assertNonCredentialInput(value, selector)
        : value;
    const desiredChecked = typeof checked === 'boolean' ? checked : undefined;
    const frames = [s.page.mainFrame?.(), ...(s.page.frames?.() ?? [])].filter(
      (frame, index, all) => frame && all.indexOf(frame) === index,
    );
    for (const frame of frames) {
      const handle = await frame.evaluateHandle(
        (target: string) => document.querySelector(target),
        selector,
      );
      try {
        const control = handle.asElement();
        if (!control) continue;
        assertNonCredentialInput(
          String(resolvedValue ?? ''),
          await control.evaluate(describeInputTarget),
        );
        const result = await control
          .evaluate(
            (element: Element, args: { value: unknown; checked?: boolean }) => {
              const { value, checked } = args;
              const el = element as
                | HTMLInputElement
                | HTMLTextAreaElement
                | HTMLSelectElement;
              el.scrollIntoView?.({ block: 'center', inline: 'center' });
              const tag = el.tagName.toLowerCase();
              const input = el as HTMLInputElement;
              const fire = () => {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
              };
              if (tag === 'select') {
                const select = el as HTMLSelectElement;
                const wanted = String(value ?? '').toLowerCase();
                let matched = false;
                for (const option of Array.from(select.options)) {
                  const text = option.text.toLowerCase();
                  const optionValue = option.value.toLowerCase();
                  if (
                    text === wanted ||
                    optionValue === wanted ||
                    text.includes(wanted) ||
                    optionValue.includes(wanted)
                  ) {
                    select.value = option.value;
                    matched = true;
                    break;
                  }
                }
                if (!matched && value != null) select.value = String(value);
                fire();
              } else if (input.type === 'checkbox' || input.type === 'radio') {
                input.checked = typeof checked === 'boolean' ? checked : true;
                fire();
              } else {
                const v = String(value ?? '');
                const proto =
                  input instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(
                  proto,
                  'value',
                )?.set;
                if (setter) setter.call(el, v);
                else (el as HTMLInputElement | HTMLTextAreaElement).value = v;
                fire();
              }
              const selectedText =
                tag === 'select'
                  ? ((el as HTMLSelectElement).selectedOptions[0]?.text ?? '')
                  : '';
              const validation = Array.from(
                document.querySelectorAll(
                  '.hs-error-msg, .hs-error-msgs label, [role="alert"], .error, .invalid, .field-error',
                ),
              )
                .map((node) =>
                  (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
                )
                .filter(Boolean)
                .slice(0, 6);
              return {
                tag,
                type: input.type || '',
                name: input.name || '',
                valuePresent: 'value' in input ? Boolean(input.value) : false,
                valueLength:
                  'value' in input ? String(input.value ?? '').length : 0,
                selectedText,
                checked:
                  typeof input.checked === 'boolean'
                    ? input.checked
                    : undefined,
                validation,
              };
            },
            { value: resolvedValue, checked: desiredChecked },
          )
          .catch((error: Error) => ({ error: error.message }));
        if (result) return `set_control ${JSON.stringify(result)}`;
      } finally {
        await handle.dispose();
      }
    }
    return 'no-element-found';
  });
}

// Without a stated amount a scroll moves one viewport, measured on the page.
export async function wsScroll(
  s: WSession,
  direction: string,
  amount?: number,
): Promise<string> {
  return s.runStep(`scroll_${direction}`, async () => {
    const step = amount === undefined ? 'window.innerHeight' : String(amount);
    const delta = direction === 'up' ? `-(${step})` : step;
    const moved = await s.page.evaluate(
      `(() => { const d = ${delta}; window.scrollBy(0, d); return Math.abs(d); })()`,
    );
    return `scrolled ${direction} ${moved}`;
  });
}
