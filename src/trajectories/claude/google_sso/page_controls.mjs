// How this login reads a live page and operates a control on it.
//
// Google's sign-in is a WIZ document: its controls become enabled a tick after
// they render, its fields ignore keystrokes until their handlers are bound, and
// an OAuth redirect can destroy the document mid-read. So a read that lost its
// document means "look again", a fill is verified by reading the value back, and
// a click waits for the control to be genuinely enabled and then moves the
// pointer onto it.
import { humanClick } from '../../../../dist/human/mouse.js';
import { DOCUMENT_REPLACED, readAcrossNavigation } from '../../_shared/services/google_sso/page_diagnostics.mjs';
import { pageCondition } from '../../_shared/page/settled.mjs';

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
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  }, patternSrc);
  await humanClick(page, Math.round(state.x), Math.round(state.y));
}
