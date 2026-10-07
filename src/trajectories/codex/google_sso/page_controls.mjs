// How this login finds and operates a control on a live page.
//
// Google's and OpenAI's sign-in surfaces are WIZ/React documents whose controls
// are divs as often as buttons, become enabled a tick after they render, and are
// replaced under the pointer by the next redirect. So every control here is
// located by what it says, measured before it is touched, and clicked with a
// humanized pointer move — a raw dispatch with no movement is the signal that
// tripped Google's "browser may not be secure" block.
import { humanClick } from '../../../../dist/human/mouse.js';
import { DOCUMENT_REPLACED, readAcrossNavigation } from '../../_shared/services/google_sso/page_diagnostics.mjs';
import { pageCondition, pageSettled } from '../../_shared/page/settled.mjs';

// In an OAuth redirect chain a navigation mid-call is the EXPECTED
// transition, so in poll loops a read whose document was replaced means
// "not ready, re-poll the new document", never a fatal error.
export async function navEval(page, fn, dflt, arg) {
  const value = await readAcrossNavigation(page, () => page.evaluate(fn, arg));
  return value === DOCUMENT_REPLACED ? dflt : value;
}

// Email/password fields: humanType (CDP default = page.keyboard.type
// per char) emits the full keydown/keyup/input sequence, which
// Google's WIZ validator needs to enable Next. Input.insertText emits only
// input and does not supply that sequence. Keystrokes go to the focused
// element, so the field must hold focus before typing: a pointer click that
// lands on a control drawn over the field (Google's identifier page shows its
// floating label there) leaves focus elsewhere and every keystroke is lost.
// The field is then focused directly, and a field that still does not hold
// focus is named in the failure. Throw if the value is not retained.
export async function fillAndVerify(page, locator, text, humanClickLocator, humanType) {
  const editable = locator.and(page.locator('input:enabled:not([readonly]), textarea:enabled:not([readonly])'));
  await editable.waitFor({ state: 'visible' });
  await humanClickLocator(page, editable);
  const focused = () => editable.evaluate((element) => element === element.ownerDocument.activeElement);
  if (!(await focused())) {
    await editable.focus();
  }
  if (!(await focused())) {
    throw new Error('fillAndVerify: the field did not take focus after a pointer click and a focus call; keystrokes would be lost');
  }
  await humanType(page, text);
  const actual = await locator.inputValue();
  if (actual !== text) {
    throw new Error(`fillAndVerify: value mismatch after input dispatch; observed length=${actual.length}, expected length=${text.length}`);
  }
}

// Wait for the button to be ENABLED then click it with a humanized pointer
// move+click (humanClick). The earlier raw CDP Input.dispatchMouseEvent issued
// a press/release with NO pointer movement — a strong automation signal that
// tripped Google's "browser or app may not be secure" block at sign-in.
// humanClick is the same primitive gmail_login_search uses to clear that exact
// gate on this engine. Browser observation and input failures propagate.
export async function waitForEnabledThenClick(page, namePattern) {
  const patternSrc = namePattern.source;
  const state = await pageCondition(page, (src) => {
    const re = new RegExp(src, 'i');
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (!re.test(txt)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, txt: txt.slice(0, 40) };
    }
    return null;
  }, patternSrc);
  console.log(`[google_sso] clicking /${patternSrc}/i at (${Math.round(state.x)},${Math.round(state.y)}) tag=${state.tag} txt=${state.txt}`);
  await humanClick(page, Math.round(state.x), Math.round(state.y));
}

// Optional controls are an observation, not a condition that must become true.
// A replaced document and an absent match stay distinct; real failures propagate.
export async function clickVisibleText(page, pattern) {
  await pageSettled(page);
  const source = pattern.source;
  const hit = await readAcrossNavigation(page, () => page.evaluate((patternSource) => {
    const matcher = new RegExp(patternSource, 'i');
    let best = null;
    for (const element of document.querySelectorAll('button,[role="button"],a,[role="link"],li,div,span')) {
      const text = (element.innerText || element.textContent || '').trim();
      if (!text || text.length > 80 || !matcher.test(text)) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) continue;
      const area = box.width * box.height;
      if (!best || area < best.area) {
        best = { x: box.x + box.width / 2, y: box.y + box.height / 2, area, text: text.slice(0, 60) };
      }
    }
    return best;
  }, source));
  if (hit === DOCUMENT_REPLACED) return { clicked: false, reason: 'document_replaced' };
  if (!hit) return { clicked: false, reason: 'not_offered' };
  await humanClick(page, Math.round(hit.x), Math.round(hit.y));
  return { clicked: true, text: hit.text };
}

