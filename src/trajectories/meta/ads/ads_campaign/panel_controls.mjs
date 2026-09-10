// The Ads Manager panel in front of us: what we press, what we type into, and
// what the page says back.
//
// Every function here answers one question about a control that is on screen
// right now - did the click land, did the field take the value, what text is
// the panel showing. A click that did not happen, a fill that did not
// complete and a field whose value could not be read back each say so; none of
// them is passed over as if it had succeeded, and a field we could not read is
// never treated as an empty field.

import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../../../dist/human/keyboard.js';

async function clickAny(s, selectors, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = s.page.locator(sel).filter({ visible: true }).first();
      if (await loc.isVisible().catch(() => false)) {
        const clicked = await humanClickLocator(s.page, loc).then(() => true).catch(() => false);
        if (!clicked) {
          const box = await loc.boundingBox();
          if (!box) {
            console.log(`[meta-ads] WARN: click did not land and the control has no box: ${label} (${sel})`);
            continue;
          }
          await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await s.wait(0.2);
          await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          console.log(`[meta-ads] clicked at the control box: ${label}`);
        } else {
          console.log(`[meta-ads] clicked: ${label}`);
        }
        await humanIdlePause('short');
        return true;
      }
    }
    await s.wait(1);
  }
  return false;
}

async function clickVisibleTextInArea(s, textRe, label, area, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await s.page.evaluate((source, flags, a) => {
      const re = new RegExp(source, flags);
      const els = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
      for (const el of els) {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!re.test(text)) continue;
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (!r.width || !r.height || style.visibility === 'hidden' || style.display === 'none') continue;
        if (a?.minX != null && r.left < a.minX) continue;
        if (a?.maxX != null && r.left > a.maxX) continue;
        if (a?.minY != null && r.top < a.minY) continue;
        if (a?.maxY != null && r.top > a.maxY) continue;
        if (a?.minW != null && r.width < a.minW) continue;
        if (a?.minH != null && r.height < a.minH) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text, tag: el.tagName, role: el.getAttribute('role') };
      }
      return null;
    }, textRe.source, textRe.flags, area);
    if (candidate) {
      await s.page.mouse.move(candidate.x, candidate.y);
      await s.wait(0.2);
      await s.page.mouse.click(candidate.x, candidate.y);
      console.log(`[meta-ads] clicked: ${label} (${candidate.text})`);
      await humanIdlePause('short');
      return true;
    }
    await s.wait(1);
  }
  return false;
}

async function clickPoint(s, x, y, label) {
  await s.page.mouse.move(x, y);
  await s.wait(0.2);
  await s.page.mouse.click(x, y);
  console.log(`[meta-ads] clicked point: ${label} (${x},${y})`);
  await humanIdlePause('short');
  return true;
}

async function closeObstructingPanels(s) {
  await clickVisibleTextInArea(s, /^×$|^Zamknij$/i, 'close panel', { minX: 1150, minY: 150 }, 1500);
  await clickAny(s, [
    '[aria-label="Close"]',
    '[aria-label="Zamknij"]',
    'div[role="button"]:has-text("×")',
  ], 'close overlay', 1500);
}

// A field whose value could not be read back is not an empty field: what it
// holds is unknown. Both answers are named so the caller can tell them apart.
async function readFieldValue(loc) {
  return await loc.evaluate((el) => el.value ?? el.innerText ?? el.textContent ?? '')
    .then((text) => ({ ok: true, text: String(text).trim() }))
    .catch((error) => ({ ok: false, reason: `field value could not be read: ${error.message}` }));
}

function holdsValue(read, value, label) {
  if (read.ok) return read.text === String(value).trim();
  console.log(`[meta-ads] WARN: ${read.reason}: ${label}`);
  return false;
}

function readFieldText(read) {
  return read.ok ? read.text : read.reason;
}

async function fillAny(s, selectors, value, label) {
  if (!value) return false;
  for (const sel of selectors) {
    const loc = s.page.locator(sel).filter({ visible: true }).first();
    if (await loc.isVisible().catch(() => false)) {
      const filled = await humanFill(s.page, loc, String(value)).then(() => true).catch(() => false);
      if (!filled) {
        console.log(`[meta-ads] WARN: fill did not complete: ${label} (${sel})`);
        continue;
      }
      console.log(`[meta-ads] filled: ${label}`);
      await humanIdlePause('short');
      return true;
    }
  }
  console.log(`[meta-ads] WARN: field not found: ${label}`);
  return false;
}

async function fillAnyReliable(s, selectors, value, label) {
  if (!value) return false;
  for (const sel of selectors) {
    const loc = s.page.locator(sel).first();
    if (!await loc.count()) continue;
    if (!await loc.scrollIntoViewIfNeeded().then(() => true).catch(() => false)) {
      console.log(`[meta-ads] WARN: could not scroll the field into view: ${label} (${sel})`);
    }
    if (!await loc.isVisible().catch(() => false)) continue;
    const before = await readFieldValue(loc);
    if (holdsValue(before, value, label)) {
      console.log(`[meta-ads] already filled: ${label}`);
      return true;
    }
    if (!await humanFill(s.page, loc, String(value)).then(() => true).catch(() => false)) {
      console.log(`[meta-ads] WARN: humanized fill did not complete: ${label} (${sel})`);
    }
    await humanIdlePause('short');
    const directFirst = await readFieldValue(loc);
    if (holdsValue(directFirst, value, label)) {
      console.log(`[meta-ads] filled directly: ${label}`);
      return true;
    }
    await loc.evaluate((el, v) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) desc.set.call(el, v);
      else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value));
    await humanIdlePause('short');
    const nativeFirst = await readFieldValue(loc);
    if (holdsValue(nativeFirst, value, label)) {
      console.log(`[meta-ads] set native value: ${label}`);
      return true;
    }
    const filled = await humanFill(s.page, loc, String(value)).then(() => true).catch(() => false);
    await humanIdlePause('short');
    const actual = await readFieldValue(loc);
    if (filled && holdsValue(actual, value, label)) {
      console.log(`[meta-ads] filled: ${label}`);
      return true;
    }
    console.log(`[meta-ads] WARN: field value mismatch: ${label} expected=${JSON.stringify(String(value))} actual=${JSON.stringify(String(readFieldText(actual) || readFieldText(nativeFirst) || readFieldText(directFirst)).slice(0, 120))}`);
    const box = await loc.boundingBox();
    if (!box) continue;
    await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await s.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await s.page.keyboard.press('Backspace');
    await humanType(s.page, String(value));
    await humanIdlePause('short');
    const typed = await readFieldValue(loc);
    if (holdsValue(typed, value, label)) {
      console.log(`[meta-ads] typed: ${label}`);
      return true;
    }
    console.log(`[meta-ads] WARN: field value mismatch: ${label} expected=${JSON.stringify(String(value))} actual=${JSON.stringify(String(readFieldText(typed)).slice(0, 120))}`);
  }
  console.log(`[meta-ads] WARN: field not found: ${label}`);
  return false;
}

async function clickNext(s, timeoutMs = 6000) {
  return await clickAny(s, [
    'div[role="button"]:has-text("Dalej")',
    'button:has-text("Dalej")',
    'div[role="button"]:has-text("Next")',
    'button:has-text("Next")',
  ], 'Next/Dalej', timeoutMs);
}

// A page whose text could not be read is not a page without text, so this
// names the read failure instead of answering with an empty string.
async function pageText(s) {
  try {
    return await s.page.evaluate(() => document.body?.innerText || '');
  } catch (error) {
    throw new Error(`page text could not be read from ${s.page.url?.() ?? ''}: ${error.message}`, { cause: error });
  }
}

export {
  clickAny,
  clickNext,
  clickPoint,
  clickVisibleTextInArea,
  closeObstructingPanels,
  fillAny,
  fillAnyReliable,
  pageText,
};
