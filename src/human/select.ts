/**
 * Select a dropdown option across native, ARIA combobox, and custom CSS implementations.
 * Lives in src/human/ alongside mouse.ts and keyboard.ts. This IS the
 * humanized select primitive: the page.evaluate calls below are read-only
 * DOM index/text queries (no synthetic clicks); all actual pointer
 * interaction routes through humanClick at resolved coordinates. Real page
 * errors (closed page, navigation) propagate to the caller's runStep
 * handler — only a genuine "not found" returns -1/null.
 */

import { humanClick } from './mouse.js';

type Page = any;

/** Scroll the nth match of `sel` into view and humanClick its centre via a
 * raw CDP pointer (move+down+up at coordinates). Resolves zero-size a11y
 * focus-proxies to their nearest sized ancestor: Discord's DOB
 * [role="combobox"] is a 0x0 `focusTarget` div whose visible clickable box
 * is the parent `selectButton` (108x38) — verified 2026-05-18 via keeper.
 * page.locator().boundingBox() returns null for the 0x0 proxy, and
 * humanClickLocator's force locator.click() throws "Element is outside of
 * the viewport"; this measure-then-coordinate-click path has neither
 * problem. Returns true on success. */
async function scrollAndClick(page: Page, sel: string, nth: number): Promise<boolean> {
  const q = JSON.stringify(sel);
  const pt = await page.evaluate(`(()=>{var els=document.querySelectorAll(${q});var node=els[${nth}];if(!node)return null;var b=node.getBoundingClientRect();var hop=0;while(node&&(b.width<1||b.height<1)&&hop<6){node=node.parentElement;hop++;if(node)b=node.getBoundingClientRect()}if(!node)return null;node.scrollIntoView({block:'center',inline:'center'});b=node.getBoundingClientRect();if(b.width<1||b.height<1)return null;return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`) as { x: number; y: number } | null;  // allow-raw-playwright: read-only geometry measure + scrollIntoView, no synthetic click
  if (!pt) return false;
  await humanClick(page, pt.x, pt.y);
  return true;
}

/** Try native <select> elements first (read-only DOM set on a real
 * <select>, no synthetic pointer event). */
async function tryNativeSelect(page: Page, value: string): Promise<string | null> {
  const vl = JSON.stringify(value.toLowerCase());
  return await page.evaluate(`(()=>{var v=${vl};var ss=document.querySelectorAll('select');for(var i=0;i<ss.length;i++){var s=ss[i];for(var j=0;j<s.options.length;j++){if(s.options[j].text.toLowerCase().indexOf(v)>=0){s.selectedIndex=j;s.dispatchEvent(new Event('change',{bubbles:true}));return s.options[j].text}}}return null})()`);  // allow-raw-playwright: native <select> value set, not a synthetic pointer click
}

async function findIndex(page: Page, selector: string, target: string, attr: string): Promise<number> {
  const q = JSON.stringify(selector); const tgt = JSON.stringify(target.toLowerCase()); const a = JSON.stringify(attr);
  return await page.evaluate(`(()=>{var tgt=${tgt};var els=document.querySelectorAll(${q});for(var i=0;i<els.length;i++){var raw=${a}==='text'?els[i].textContent:els[i].getAttribute(${a});var src=raw?raw.trim().toLowerCase():'';if(src.indexOf(tgt)>=0)return i}return -1})()`) as number;  // allow-raw-playwright: read-only DOM index query, no interaction
}

async function findOptionIndex(page: Page, selector: string, value: string): Promise<number> {
  const q = JSON.stringify(selector); const v = JSON.stringify(value.toLowerCase());
  return await page.evaluate(`(()=>{var v=${v};var opts=document.querySelectorAll(${q});for(var i=0;i<opts.length;i++){var t=opts[i].textContent;var s=t?t.trim().toLowerCase():'';if(s===v)return i}for(var i=0;i<opts.length;i++){var t2=opts[i].textContent;var s2=t2?t2.trim().toLowerCase():'';if(s2.indexOf(v)>=0)return i}return -1})()`) as number;  // allow-raw-playwright: read-only DOM index query, no interaction
}

/** ARIA combobox. Opens the combobox and selects the option via a
 * coordinate humanClick (scroll-into-view + CDP pointer). The prior raw
 * Playwright synthetic click did not reliably open Discord's custom React
 * combobox; verified 2026-05-18 (the listbox stayed closed so every DOB
 * select returned no-select-found). */
async function tryAriaCombobox(page: Page, target: string, value: string): Promise<string | null> {
  const idx = await findIndex(page, '[role="combobox"]', target, 'aria-label');
  if (idx < 0) return null;
  if (!(await scrollAndClick(page, '[role="combobox"]', idx))) return null;
  await new Promise(r => setTimeout(r, 500));  // allow-raw-playwright: implementation file — defines the humanized atom
  const oi = await findOptionIndex(page, '[role="option"]', value);
  if (oi >= 0) {
    if (await scrollAndClick(page, '[role="option"]', oi)) return value.toLowerCase();
  }
  const getFocused = `(()=>{var el=document.querySelector('[role="option"][data-focus-visible="true"],[role="option"][aria-selected="true"]');return el?el.textContent.trim().toLowerCase():null})()`;
  for (let i = 0; i < 150; i++) {
    await page.keyboard.press('ArrowDown');
    await new Promise(r => setTimeout(r, 50));  // allow-raw-playwright: implementation file — defines the humanized atom
    const focused = await page.evaluate(getFocused) as string | null;  // allow-raw-playwright: read-only focused-option text read, no interaction
    if (focused === value.toLowerCase() || (focused && focused.indexOf(value.toLowerCase()) >= 0)) {
      await page.keyboard.press('Enter');
      return focused;
    }
  }
  return null;
}

/** CSS-class dropdowns — coordinate humanClick, same rationale. */
async function tryCssDropdown(page: Page, target: string, value: string): Promise<string | null> {
  const containerSel = '[class*="select"],[class*="Select"],[class*="dropdown"],[class*="Dropdown"]';
  const optionSel = '[role="option"],[class*="option"],[class*="Option"],li';
  const idx = await findIndex(page, containerSel, target, 'text');
  if (idx < 0) return null;
  if (!(await scrollAndClick(page, containerSel, idx))) return null;
  await new Promise(r => setTimeout(r, 500));  // allow-raw-playwright: implementation file — defines the humanized atom
  const oi = await findOptionIndex(page, optionSel, value);
  if (oi < 0) return null;
  if (!(await scrollAndClick(page, optionSel, oi))) return null;
  return value.toLowerCase();
}

/** Select a dropdown option. Tries native, ARIA combobox, then CSS custom
 * dropdowns. A genuine miss returns null; a real page error propagates to
 * the caller (WSession.select wraps this in runStep). */
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
