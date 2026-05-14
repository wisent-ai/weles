/**
 * Select a dropdown option across native, ARIA combobox, and custom CSS implementations.
 * All clicks and key presses route through the OS event queue via humanized atoms.
 */

import { humanClickLocator } from './mouse.js';
import { nativeKeyPress } from './mouse-native.js';
import { waitMs } from '../utils/timing.js';

type Page = any;

/**
 * Try native <select> by clicking it open then driving the option highlight
 * with arrow-down + Return, all through the OS event queue. Returns the
 * selected option text or null when no <select> matches.
 *
 * Earlier versions issued a JS-dispatched change event inside page.evaluate,
 * which is isTrusted=false — easy classifier flag. The arrow-key walk
 * replaces that with real OS-queue key events.
 */
async function tryNativeSelect(page: Page, value: string): Promise<string | null> {
  const vl = value.toLowerCase();
  const selects = page.locator?.('select');
  if (!selects) return null;
  let count = 0;
  try { count = await selects.count(); } catch { return null; }
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    let texts: string[] = [];
    try { texts = await sel.evaluate((s: any) => Array.from(s.options).map((o: any) => o.text)); } catch { continue; }
    const idx = texts.findIndex(t => t && t.toLowerCase().includes(vl));
    if (idx < 0) continue;
    try { await humanClickLocator(page, sel); } catch { continue; }
    let currentIdx = -1;
    try { currentIdx = await sel.evaluate((s: any) => s.selectedIndex); } catch { return null; }
    const steps = idx - currentIdx;
    const key = steps >= 0 ? 'arrow-down' : 'arrow-up';
    for (let k = 0; k < Math.abs(steps); k++) {
      nativeKeyPress(key);
      await waitMs(40);
    }
    nativeKeyPress('return');
    return texts[idx];
  }
  return null;
}

async function findIndexByText(page: Page, selector: string, target: string, attr: string): Promise<number> {
  const lt = target.toLowerCase();
  try {
    return await page.evaluate(
      ({ q, tgt, a }: { q: string; tgt: string; a: string }) => {
        const els = document.querySelectorAll(q);
        for (let i = 0; i < els.length; i++) {
          const e = els[i] as Element;
          const raw = a === 'text' ? e.textContent : e.getAttribute(a);
          if (!raw) continue;
          const src = raw.trim().toLowerCase();
          if (src.indexOf(tgt) >= 0) return i;
        }
        return -1;
      },
      { q: selector, tgt: lt, a: attr },
    );
  } catch { return -1; }
}

async function findOptionIndex(page: Page, selector: string, value: string): Promise<number> {
  const lv = value.toLowerCase();
  try {
    return await page.evaluate(
      ({ q, v }: { q: string; v: string }) => {
        const opts = document.querySelectorAll(q);
        for (let i = 0; i < opts.length; i++) {
          const raw = opts[i].textContent;
          if (!raw) continue;
          if (raw.trim().toLowerCase() === v) return i;
        }
        for (let i = 0; i < opts.length; i++) {
          const raw = opts[i].textContent;
          if (!raw) continue;
          if (raw.trim().toLowerCase().indexOf(v) >= 0) return i;
        }
        return -1;
      },
      { q: selector, v: lv },
    );
  } catch { return -1; }
}

async function focusedOptionText(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('[role="option"][data-focus-visible="true"],[role="option"][aria-selected="true"]');
      if (!el) return null;
      const raw = el.textContent;
      if (!raw) return null;
      return raw.trim().toLowerCase();
    });
  } catch { return null; }
}

/** ARIA combobox: humanClick container open; walk arrow-down + Return via OS event queue. */
async function tryAriaCombobox(page: Page, target: string, value: string): Promise<string | null> {
  const idx = await findIndexByText(page, '[role="combobox"]', target, 'aria-label');
  if (idx < 0) return null;
  try { await humanClickLocator(page, page.locator('[role="combobox"]').nth(idx)); } catch { return null; }
  await waitMs(500);
  const oi = await findOptionIndex(page, '[role="option"]', value);
  if (oi >= 0) {
    try { await humanClickLocator(page, page.locator('[role="option"]').nth(oi)); return value.toLowerCase(); } catch { /* try keyboard walk below */ }
  }
  const lv = value.toLowerCase();
  for (let i = 0; i < 150; i++) {
    nativeKeyPress('arrow-down');
    await waitMs(50);
    const focused = await focusedOptionText(page);
    if (focused === lv || (focused && focused.indexOf(lv) >= 0)) {
      nativeKeyPress('return');
      return focused;
    }
  }
  return null;
}

/** CSS-class dropdowns — humanClick container open, then humanClick matching option. */
async function tryCssDropdown(page: Page, target: string, value: string): Promise<string | null> {
  const containerSel = '[class*="select"],[class*="Select"],[class*="dropdown"],[class*="Dropdown"]';
  const optionSel = '[role="option"],[class*="option"],[class*="Option"],li';
  const idx = await findIndexByText(page, containerSel, target, 'text');
  if (idx < 0) return null;
  try { await humanClickLocator(page, page.locator(containerSel).nth(idx)); } catch { return null; }
  await waitMs(500);
  const oi = await findOptionIndex(page, optionSel, value);
  if (oi < 0) return null;
  try { await humanClickLocator(page, page.locator(optionSel).nth(oi)); return value.toLowerCase(); } catch { return null; }
}

/** Select a dropdown option. Tries native, ARIA combobox, then CSS custom dropdowns. */
export async function selectOption(page: Page, target: string, value: string): Promise<string | null> {
  console.log(`[select] target="${target}" value="${value}"`);
  const native = await tryNativeSelect(page, value);
  if (native) { console.log(`[select] native hit: ${native}`); return native; }
  const aria = await tryAriaCombobox(page, target, value);
  if (aria) { console.log(`[select] combobox hit: ${aria}`); return aria; }
  const css = await tryCssDropdown(page, target, value);
  if (css) { console.log(`[select] css dropdown hit: ${css}`); return css; }
  console.log(`[select] no match for target="${target}" value="${value}"`);
  return null;
}
