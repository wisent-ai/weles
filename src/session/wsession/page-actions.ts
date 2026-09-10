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

export async function wsFocus(s: WSession, selector: string): Promise<string> {
  return s.runStep(`focus_${selector}`, async () => {
    const simple = selector.split(' ').pop()?.toLowerCase().replace(/['"[\]]/g, '') ?? '';
    const sels = [selector, `input[name="${selector}"]`, `input[type="${selector}"]`, `input[placeholder*="${selector}" i]`];
    if (simple && simple !== selector) sels.push(`input[name="${simple}"]`, `input[placeholder*="${simple}" i]`);
    for (const candidate of sels) { try { const b = await s.page.locator?.(candidate)?.first?.()?.boundingBox?.(); if (b) { await humanClick(s.page, b.x + b.width / 2, b.y + b.height / 2); return `focused: ${candidate}`; } } catch {} }
    return 'no-element-found';
  });
}

export async function wsClickSelector(s: WSession, selector: string): Promise<string> {
  return s.runStep(`clickSel_${selector.slice(0,30)}`, async () => { const loc = s.page.locator(selector).first(); if (!(await loc.count())) return 'no-element-found'; await humanClickLocator(s.page, loc); return `clicked ${selector.slice(0,60)}`; });
}

export async function wsJsClick(s: WSession, selector?: string, text?: string): Promise<string> {
  return s.runStep(`jsClick_${text ?? selector}`, async () => {
    const sel = JSON.stringify(selector ?? ''), txt = JSON.stringify((text ?? '').toLowerCase());
    const sr = await s.page.evaluate(`(()=>{var t=${txt};function F(r){var a=[];r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot){var sr=e.shadowRoot;a=a.concat(Array.from(sr.querySelectorAll('[data-post-click-location] button')));a=a.concat(F(sr))}});return a}var bs=F(document);if(t&&t.indexOf('upvote')>=0&&bs.length>0){bs[0].click();return'clicked upvote (shadow)'}if(t&&t.indexOf('downvote')>=0&&bs.length>1){bs[1].click();return'clicked downvote (shadow)'}return null})()`);
    if (sr) return sr;
    for (const frame of s.page.frames?.() ?? []) {
      if (frame === s.page.mainFrame?.()) continue;
      if (selector) {
        try {
          const loc = frame.locator(selector).first();
          if (await loc.count()) { await loc.click(); return `clicked frame: ${selector.slice(0, 60)}`; }
        } catch { /* try frame eval */ }
      }
      if (text) {
        try {
          const loc = frame.getByText(new RegExp(text, 'i')).first();
          if (await loc.count() && await loc.isVisible().catch(() => false)) {
            await humanClickLocator(s.page, loc);
            return `clicked frame text: ${text.slice(0, 60)}`;
          }
        } catch { /* try frame eval */ }
      }
      const frameHit = await frame.evaluate(`(()=>{function F(r,s){var a=Array.from(r.querySelectorAll(s));r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)a=a.concat(F(e.shadowRoot,s))});return a}var s=${sel},t=${txt};function fire(e){e.click();if((e instanceof HTMLInputElement)&&(e.type==='checkbox'||e.type==='radio')){e.checked=true;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))}}if(s){try{var e=F(document,s)[0];if(e){fire(e);return'clicked-frame-untrusted: '+s}}catch(e){}}if(t){var els=F(document,'label,button,a,[role="button"],[role="checkbox"],[role="radio"],input[type="checkbox"],input[type="radio"]');for(var i=0;i<els.length;i++){var x=((els[i].textContent||'')+(els[i].getAttribute('aria-label')||'')+(els[i].getAttribute('name')||'')).toLowerCase();if(x.indexOf(t)>=0){fire(els[i]);var forId=els[i].getAttribute&&els[i].getAttribute('for');if(forId){var input=document.getElementById(forId);if(input)fire(input)}return'clicked-frame-untrusted: '+x.trim().slice(0,40)}}}return null})()`);
      if (frameHit) return frameHit;
    }
    if (selector) { try { const loc = s.page.locator(selector).first(); if (await loc.count()) { await loc.click(); return `clicked: ${selector.slice(0, 60)}`; } } catch { /* try eval */ } }
    if (text) { try { const loc = s.page.getByRole('button', { name: new RegExp(text, 'i') }).first(); if (await loc.count()) { await loc.click(); return `clicked text: ${text.slice(0, 60)}`; } } catch { /* try eval */ } }
    const r = await s.page.evaluate(`(()=>{function F(r,s){var a=Array.from(r.querySelectorAll(s));r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)a=a.concat(F(e.shadowRoot,s))});return a}var s=${sel},t=${txt};if(s){try{var e=F(document,s)[0];if(e){e.click();return'clicked-untrusted: '+s}}catch(e){}}if(t){var els=F(document,'button,a,[role="button"],[class*="vote"],[class*="like"],[class*="star"],[class*="follow"]');for(var i=0;i<els.length;i++){var x=((els[i].textContent||'')+(els[i].getAttribute('aria-label')||'')).toLowerCase();if(x.indexOf(t)>=0){els[i].click();return'clicked-untrusted: '+(els[i].getAttribute('aria-label')||els[i].textContent||'').trim().slice(0,40)}}}return null})()`);
    return r ?? 'no-element-found';
  });
}

export async function wsSetControl(s: WSession, selector: string, value?: unknown, checked?: unknown): Promise<string> {
  return s.runStep(`setControl_${selector.slice(0, 60)}`, async () => {
    if (!selector.trim()) return 'no-selector';
    const resolvedValue = typeof value === 'string' ? s.resolveEnv(value) : value;
    const desiredChecked = typeof checked === 'boolean' ? checked : undefined;
    const frames = [s.page.mainFrame?.(), ...(s.page.frames?.() ?? [])]
      .filter((frame, index, all) => frame && all.indexOf(frame) === index);
    for (const frame of frames) {
      const result = await frame.evaluate((args: { selector: string; value: unknown; checked?: boolean }) => {
        const { selector, value, checked } = args;
        const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
        if (!el) return null;
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
            if (text === wanted || optionValue === wanted || text.includes(wanted) || optionValue.includes(wanted)) {
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
          const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, v);
          else (el as HTMLInputElement | HTMLTextAreaElement).value = v;
          fire();
        }
        const selectedText = tag === 'select'
          ? ((el as HTMLSelectElement).selectedOptions[0]?.text ?? '')
          : '';
        const validation = Array.from(document.querySelectorAll('.hs-error-msg, .hs-error-msgs label, [role="alert"], .error, .invalid, .field-error'))
          .map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 6);
        return {
          tag,
          type: input.type || '',
          name: input.name || '',
          valuePresent: 'value' in input ? Boolean(input.value) : false,
          valueLength: 'value' in input ? String(input.value ?? '').length : 0,
          selectedText,
          checked: typeof input.checked === 'boolean' ? input.checked : undefined,
          validation,
        };
      }, { selector, value: resolvedValue, checked: desiredChecked }).catch((error: Error) => ({ error: error.message.slice(0, 160) }));
      if (result) return `set_control ${JSON.stringify(result).slice(0, 500)}`;
    }
    return 'no-element-found';
  });
}

export async function wsScroll(s: WSession, direction: string, amount?: number): Promise<string> {
  return s.runStep(`scroll_${direction}`, async () => {
    const delta = (direction === 'up' ? -(amount ?? 400) : (amount ?? 400));
    await s.page.evaluate(`window.scrollBy(0, ${delta})`);
    return `scrolled ${direction} ${amount ?? 400}`;
  });
}
