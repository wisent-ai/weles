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

/** Try ARIA combobox (role="combobox" + role="option") — Discord, React custom selects. */
async function tryAriaCombobox(page: Page, target: string, value: string): Promise<string | null> {
  const tgtLow = JSON.stringify(target.toLowerCase());
  const vl = JSON.stringify(value.toLowerCase());
  const opened = await page.evaluate(`(()=>{var tgt=${tgtLow};var cbs=document.querySelectorAll('[role="combobox"]');for(var i=0;i<cbs.length;i++){var lbl=(cbs[i].getAttribute('aria-label')||'').toLowerCase();if(lbl.indexOf(tgt)>=0){cbs[i].click();return true}}return false})()`).catch(() => false);
  if (!opened) return null;
  await new Promise(r => setTimeout(r, 500));
  // Find visible option and click it
  const findAndClick = `(()=>{var v=${vl};var opts=document.querySelectorAll('[role="option"]');for(var i=0;i<opts.length;i++){var t=opts[i].textContent.trim().toLowerCase();if(t===v){opts[i].click();return t}}for(var i=0;i<opts.length;i++){var t=opts[i].textContent.trim().toLowerCase();if(t.indexOf(v)>=0){opts[i].click();return t}}return null})()`;
  const direct = await page.evaluate(findAndClick).catch(() => null);
  if (direct) return direct;
  // Virtualized list: use keyboard ArrowDown to navigate one option at a time
  const getFocused = `(()=>{var el=document.querySelector('[role="option"][data-focus-visible="true"],[role="option"][aria-selected="true"]');return el?el.textContent.trim().toLowerCase():null})()`;
  for (let i = 0; i < 150; i++) {
    await page.keyboard.press('ArrowDown');
    await new Promise(r => setTimeout(r, 50));
    const focused = await page.evaluate(getFocused).catch(() => null);
    if (focused === value.toLowerCase() || (focused && focused.indexOf(value.toLowerCase()) >= 0)) {
      await page.keyboard.press('Enter');
      console.log(`[select] keyboard nav found "${focused}" after ${i + 1} arrows`);
      return focused;
    }
  }
  return null;
}

/** Try CSS class-based custom dropdowns (class*="select"/"dropdown"). */
async function tryCssDropdown(page: Page, target: string, value: string): Promise<string | null> {
  const tgtLow = JSON.stringify(target.toLowerCase());
  const vl = JSON.stringify(value.toLowerCase());
  const opened = await page.evaluate(`(()=>{var tgt=${tgtLow};var els=document.querySelectorAll('[class*="select"],[class*="Select"],[class*="dropdown"],[class*="Dropdown"]');for(var i=0;i<els.length;i++){var t=els[i].textContent.trim().toLowerCase();if(t.indexOf(tgt)===0||t===tgt){els[i].click();return true}}return false})()`).catch(() => false);
  if (!opened) return null;
  await new Promise(r => setTimeout(r, 500));
  return page.evaluate(`(()=>{var v=${vl};var items=document.querySelectorAll('[role="option"],[class*="option"],[class*="Option"],li');for(var i=0;i<items.length;i++){var t=items[i].textContent.trim().toLowerCase();if(t===v&&items[i].children.length===0){items[i].click();return items[i].textContent.trim()}}for(var i=0;i<items.length;i++){var t=items[i].textContent.trim().toLowerCase();if(t.indexOf(v)>=0&&items[i].children.length===0){items[i].click();return items[i].textContent.trim()}}return null})()`).catch(() => null);
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
