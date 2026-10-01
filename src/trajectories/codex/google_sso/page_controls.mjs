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
// Google's WIZ validator needs to enable Next — Input.insertText
// fired only `input` so the password page's Next stayed DISABLED
// (frames 2026-05-18 23:25:27). Single-shot: throw on failure.
export async function fillAndVerify(page, locator, text, humanClickLocator, humanType) {
  const editable = locator.and(page.locator('input:enabled:not([readonly]), textarea:enabled:not([readonly])'));
  await editable.waitFor({ state: 'visible' });
  await humanClickLocator(page, editable);
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

export async function clickVisibleText(page, pattern) {
  const source = pattern.source;
  const hit = await pageCondition(page, (patternSource) => {
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
  }, source);
  await humanClick(page, Math.round(hit.x), Math.round(hit.y));
  return hit.text;
}

// Click "Use another account" / "Add account" on the Google account chooser so
// a first-time account (no existing chooser row) can be entered fresh.
export async function clickUseAnotherAccount(page) {
  const hit = await pageCondition(page, () => {
    const re = /use another account|add account|dodaj konto|inne konto/i;
    for (const el of document.querySelectorAll('div,button,[role="button"],li,a')) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (!re.test(txt) || txt.length > 40) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  });
  await humanClick(page, Math.round(hit.x), Math.round(hit.y));
}

// Click the Google account-chooser row matching the given email.
// The row is a div, not a button, so waitForEnabledThenClick won't
// find it. DOM-walk for any element whose visible text contains
// the email, take its bounding-box center, CDP-click.
export async function clickEmailRow(page, email) {
  const hit = await pageCondition(page, (e) => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (!txt.includes(e)) continue;
      if (el.children.length > 0) {
        const childMatches = Array.from(el.children).some((c) => (c.innerText || c.textContent || '').includes(e));
        if (childMatches) continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;
      let target = el;
      for (let p = el; p; p = p.parentElement) {
        if (p.getAttribute && (p.getAttribute('role') === 'link' || p.tagName === 'A' || p.tagName === 'LI' || p.tagName === 'BUTTON' || p.getAttribute('data-identifier'))) { target = p; break; }
      }
      const tr = target.getBoundingClientRect();
      return { x: tr.x + tr.width / 2, y: tr.y + tr.height / 2, txt: txt.slice(0, 80) };
    }
    return null;
  }, email);
  // Humanized pointer move+click (not raw CDP dispatch) — same anti-block
  // rationale as waitForEnabledThenClick.
  await humanClick(page, Math.round(hit.x), Math.round(hit.y));
}
