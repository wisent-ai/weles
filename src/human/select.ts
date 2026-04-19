/**
 * Select a dropdown option across native, ARIA combobox, and custom CSS implementations.
 * Lives in src/human/ alongside mouse.ts and keyboard.ts.
 */

type Page = any;

/** Try native <select> elements first. */
async function tryNativeSelect(page: Page, value: string): Promise<string | null> {
  const vl = JSON.stringify(value.toLowerCase());
  return page.evaluate(`(()=>{var v=${vl};var ss=document.querySelectorAll('select');for(var i=0;i<ss.length;i++){var s=ss[i];for(var j=0;j<s.options.length;j++){if(s.options[j].text.toLowerCase().indexOf(v)>=0){s.selectedIndex=j;s.dispatchEvent(new Event('change',{bubbles:true}));return s.options[j].text}}}return null})()`).catch(() => null);
}

async function findIndex(page: Page, selector: string, target: string, attr: string): Promise<number> {
  const q = JSON.stringify(selector); const tgt = JSON.stringify(target.toLowerCase()); const a = JSON.stringify(attr);
  return page.evaluate(`(()=>{var tgt=${tgt};var els=document.querySelectorAll(${q});for(var i=0;i<els.length;i++){var src=${a}==='text'?(els[i].textContent||'').trim().toLowerCase():(els[i].getAttribute(${a})||'').toLowerCase();if(src.indexOf(tgt)>=0)return i}return -1})()`).catch(() => -1) as Promise<number>;
}

async function findOptionIndex(page: Page, selector: string, value: string): Promise<number> {
  const q = JSON.stringify(selector); const v = JSON.stringify(value.toLowerCase());
  return page.evaluate(`(()=>{var v=${v};var opts=document.querySelectorAll(${q});for(var i=0;i<opts.length;i++){if((opts[i].textContent||'').trim().toLowerCase()===v)return i}for(var i=0;i<opts.length;i++){if((opts[i].textContent||'').trim().toLowerCase().indexOf(v)>=0)return i}return -1})()`).catch(() => -1) as Promise<number>;
}

/** ARIA combobox via CDP locator.click (isTrusted=true). TikTok flags
 * JS-dispatched element.click inside page.evaluate (isTrusted=false) at
 * /register_verify_login/ with error_code:7. Verified 2026-04-19: this CDP
 * refactor lets fully-automated weles signup complete end-to-end. */
async function tryAriaCombobox(page: Page, target: string, value: string): Promise<string | null> {
  const idx = await findIndex(page, '[role="combobox"]', target, 'aria-label');
  if (idx < 0) return null;
  const clicked = await page.locator('[role="combobox"]').nth(idx).click().then(() => true).catch(() => false);
  if (!clicked) return null;
  await new Promise(r => setTimeout(r, 500));
  const oi = await findOptionIndex(page, '[role="option"]', value);
  if (oi >= 0) {
    const ok = await page.locator('[role="option"]').nth(oi).click().then(() => true).catch(() => false);
    if (ok) return value.toLowerCase();
  }
  const getFocused = `(()=>{var el=document.querySelector('[role="option"][data-focus-visible="true"],[role="option"][aria-selected="true"]');return el?el.textContent.trim().toLowerCase():null})()`;
  for (let i = 0; i < 150; i++) {
    await page.keyboard.press('ArrowDown');
    await new Promise(r => setTimeout(r, 50));
    const focused = await page.evaluate(getFocused).catch(() => null);
    if (focused === value.toLowerCase() || (focused && focused.indexOf(value.toLowerCase()) >= 0)) {
      await page.keyboard.press('Enter');
      return focused;
    }
  }
  return null;
}

/** CSS-class dropdowns via CDP locator.click — same isTrusted rationale. */
async function tryCssDropdown(page: Page, target: string, value: string): Promise<string | null> {
  const containerSel = '[class*="select"],[class*="Select"],[class*="dropdown"],[class*="Dropdown"]';
  const optionSel = '[role="option"],[class*="option"],[class*="Option"],li';
  const idx = await findIndex(page, containerSel, target, 'text');
  if (idx < 0) return null;
  const opened = await page.locator(containerSel).nth(idx).click().then(() => true).catch(() => false);
  if (!opened) return null;
  await new Promise(r => setTimeout(r, 500));
  const oi = await findOptionIndex(page, optionSel, value);
  if (oi < 0) return null;
  const ok = await page.locator(optionSel).nth(oi).click().then(() => true).catch(() => false);
  return ok ? value.toLowerCase() : null;
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
