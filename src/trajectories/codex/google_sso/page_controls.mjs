// How this login finds and operates a control on a live page.
//
// Google's and OpenAI's sign-in surfaces are WIZ/React documents whose controls
// are divs as often as buttons, become enabled a tick after they render, and are
// replaced under the pointer by the next redirect. So every control here is
// located by what it says, measured before it is touched, and clicked with a
// humanized pointer move — a raw dispatch with no movement is the signal that
// tripped Google's "browser may not be secure" block.
import { humanClick } from '../../../../dist/human/mouse.js';

// page.evaluate throws "Execution context was destroyed" when the
// page navigates mid-call. In an OAuth redirect chain a navigation
// is the EXPECTED transition, so in poll loops it must mean "not
// ready, re-poll the new document", never a fatal error.
export async function navEval(page, fn, dflt, arg) {
  try { return await page.evaluate(fn, arg); }
  catch (e) {
    if (/destroyed|navigation|Target closed|crashed|detached|Session closed/i.test(e.message)) return dflt;
    throw e;
  }
}

// Email/password fields: humanType (CDP default = page.keyboard.type
// per char) emits the full keydown/keyup/input sequence, which
// Google's WIZ validator needs to enable Next — Input.insertText
// fired only `input` so the password page's Next stayed DISABLED
// (frames 2026-05-18 23:25:27). Single-shot: throw on failure.
export async function fillAndVerify(page, locator, text, humanClickLocator, humanType) {
  await locator.waitFor({ state: 'visible' });
  for (let i = 0; i < 50; i += 1) {
    if (await locator.isEditable()) break;
    await page.waitForTimeout(100); // allow-raw-playwright: post-hydration poll, not a humanized action
  }
  await humanClickLocator(page, locator);
  await humanType(page, text);
  for (let i = 0; i < 20; i += 1) {
    const v = await locator.inputValue();
    if (v === text) return;
    await page.waitForTimeout(100); // allow-raw-playwright: input-value poll, not a humanized action
  }
  const final = await locator.inputValue();
  throw new Error(`fillAndVerify: humanType value did not land; field="${final}" expected len=${text.length}`);
}

// Wait for the button to be ENABLED then click it with a humanized pointer
// move+click (humanClick). The earlier raw CDP Input.dispatchMouseEvent issued
// a press/release with NO pointer movement — a strong automation signal that
// tripped Google's "browser or app may not be secure" block at sign-in.
// humanClick is the same primitive gmail_login_search uses to clear that exact
// gate on this engine. Throws the button-state diag on timeout.
export async function waitForEnabledThenClick(page, namePattern) {
  const patternSrc = namePattern.source;
  let lastState = null;
  for (let i = 0; i < 80; i += 1) {
    lastState = await navEval(page, (src) => {
      const re = new RegExp(src, 'i');
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const el of buttons) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!re.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null;
        return {
          x: r.x + r.width / 2, y: r.y + r.height / 2,
          tag: el.tagName, txt: txt.slice(0, 40),
          disabled, found: true,
        };
      }
      return { found: false };
    }, { found: false }, patternSrc);
    if (lastState.found && !lastState.disabled) {
      console.log(`[google_sso] clicking /${patternSrc}/i at (${Math.round(lastState.x)},${Math.round(lastState.y)}) tag=${lastState.tag} txt=${lastState.txt}`);
      await humanClick(page, Math.round(lastState.x), Math.round(lastState.y));
      await page.waitForTimeout(800); // allow-raw-playwright: post-click settle, not a humanized action
      return;
    }
    await page.waitForTimeout(100); // allow-raw-playwright: enable-state poll, not a humanized action
  }
  throw new Error(`waitForEnabledThenClick: button stuck unclickable for /${patternSrc}/i, lastState=${JSON.stringify(lastState)}`);
}

export async function clickVisibleText(page, pattern) {
  const source = pattern.source;
  let hit = null;
  for (let i = 0; i < 60; i += 1) {
    hit = await navEval(page, (patternSource) => {
      const matcher = new RegExp(patternSource, 'i');
      let best = null;
      for (const element of Array.from(document.querySelectorAll('button,[role="button"],a,[role="link"],li,div,span'))) {
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
    }, null, source);
    if (hit) break;
    await page.waitForTimeout(100);
  }
  if (!hit) throw new Error(`no visible control matching /${source}/i`);
  await humanClick(page, Math.round(hit.x), Math.round(hit.y));
  return hit.text;
}

// Click "Use another account" / "Add account" on the Google account chooser so
// a first-time account (no existing chooser row) can be entered fresh.
export async function clickUseAnotherAccount(page) {
  let hit = null;
  for (let i = 0; i < 40; i += 1) {
    hit = await page.evaluate(() => {
      const re = /use another account|add account|dodaj konto|inne konto/i;
      const els = Array.from(document.querySelectorAll('div,button,[role="button"],li,a'));
      for (const el of els) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!re.test(txt) || txt.length > 40) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    });
    if (hit) break;
    await page.waitForTimeout(150); // allow-raw-playwright: chooser-render poll
  }
  if (!hit) throw new Error('clickUseAnotherAccount: no "Use another account" control found');
  await humanClick(page, Math.round(hit.x), Math.round(hit.y));
}

// Click the Google account-chooser row matching the given email.
// The row is a div, not a button, so waitForEnabledThenClick won't
// find it. DOM-walk for any element whose visible text contains
// the email, take its bounding-box center, CDP-click.
export async function clickEmailRow(page, email) {
  let hit = null;
  for (let i = 0; i < 100; i += 1) {
    hit = await page.evaluate((e) => {
      const els = Array.from(document.querySelectorAll('*'));
      for (const el of els) {
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
    if (hit) break;
    await page.waitForTimeout(100); // allow-raw-playwright: account-row appearance poll
  }
  if (!hit) throw new Error(`clickEmailRow: no row matching ${email} found`);
  // Humanized pointer move+click (not raw CDP dispatch) — same anti-block
  // rationale as waitForEnabledThenClick.
  await humanClick(page, Math.round(hit.x), Math.round(hit.y));
}
