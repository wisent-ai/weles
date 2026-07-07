// Google-SSO sub-flow for the OpenAI/Codex device-auth login trajectory.
//
// ROOT CAUSE: auth.openai.com's "Continue with Google" is a Google Identity
// Services (GIS) button. Clicking it with no Google session logs "Provider's
// accounts list is empty." and does nothing. So we establish a Google session
// at accounts.google.com FIRST, then reload the OpenAI device-auth URL — GIS
// then has an account and the handoff completes.
import { humanClick } from '../../../dist/human/mouse.js';
import crypto from 'node:crypto';

// RFC 6238 TOTP (SHA1, 6-digit, 30s) from a base32 secret. Verified against the
// RFC test vectors. Used to answer a Google 2FA prompt from a stored secret
// instead of a manually-provided one-time code.
function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s).replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = ''; const out = [];
  for (const c of clean) { const v = A.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secretB32, forTime = Date.now(), digits = 6, step = 30) {
  const key = b32decode(secretB32);
  let t = Math.floor((forTime / 1000) / step);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i -= 1) { buf[i] = t & 0xff; t = Math.floor(t / 256); }
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(n % (10 ** digits)).padStart(digits, '0');
}
// Prefer a live TOTP from login.totpSecret; fall back to a manually-supplied
// CODEX_2FA_CODE env. Returns null when neither is available.
function resolveOtp(login) {
  if (login && login.totpSecret) {
    try { return totp(login.totpSecret); } catch (e) { console.log(`[google_sso] totp gen failed: ${e.message}`); }
  }
  return process.env.CODEX_2FA_CODE || null;
}
// Click "Use another account" / "Add account" on the Google account chooser so
// a first-time account (no existing chooser row) can be entered fresh.
async function clickUseAnotherAccount(page) {
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

// On a Google 2FA challenge, switch to the authenticator-app (TOTP) method:
// click "Try another way", then the authenticator option. Returns true if a
// method switch was performed, false if no method-chooser is present (e.g. the
// account has no 2FA at all). This lets the login answer 2FA from a stored TOTP
// secret instead of a push/SMS prompt the headless automation can't complete.
async function selectAuthenticatorMethod(page) {
  const clickByText = async (re) => {
    for (let i = 0; i < 30; i += 1) {
      const hit = await page.evaluate((src) => {
        const rx = new RegExp(src, 'i');
        const els = Array.from(document.querySelectorAll('div,button,[role="button"],li,a,span'));
        for (const el of els) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (!rx.test(txt) || txt.length > 60) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return null;
      }, re.source);
      if (hit) { await humanClick(page, Math.round(hit.x), Math.round(hit.y)); return true; }
      await page.waitForTimeout(150); // allow-raw-playwright: challenge-render poll
    }
    return false;
  };
  // "Try another way" only exists when a 2FA challenge is on screen.
  const opened = await clickByText(/try another way|more ways to verify|inny sposob|wiecej sposobow/i);
  if (!opened) return false;
  await page.waitForTimeout(800); // allow-raw-playwright: method-list render
  // Pick the authenticator-app option (Google Authenticator / authenticator app).
  const picked = await clickByText(/authenticator app|google authenticator|authenticator/i);
  if (picked) await page.waitForTimeout(800); // allow-raw-playwright: otp-field render
  return picked;
}

// Email/password fields: humanType (CDP default = page.keyboard.type
// per char) emits the full keydown/keyup/input sequence, which
// Google's WIZ validator needs to enable Next — Input.insertText
// fired only `input` so the password page's Next stayed DISABLED
// (frames 2026-05-18 23:25:27). Single-shot: throw on failure.
async function fillAndVerify(page, locator, text, humanClickLocator, humanType) {
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

// page.evaluate throws "Execution context was destroyed" when the
// page navigates mid-call. In an OAuth redirect chain a navigation
// is the EXPECTED transition, so in poll loops it must mean "not
// ready, re-poll the new document", never a fatal error.
async function navEval(page, fn, dflt, arg) {
  try { return await page.evaluate(fn, arg); }
  catch (e) {
    if (/destroyed|navigation|Target closed|crashed|detached|Session closed/i.test(e.message)) return dflt;
    throw e;
  }
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
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const el of candidates) {
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
      try { await page.waitForTimeout(800); } catch {}
      return;
    }
    await page.waitForTimeout(100); // allow-raw-playwright: enable-state poll, not a humanized action
  }
  throw new Error(`waitForEnabledThenClick: button stuck unclickable for /${patternSrc}/i, lastState=${JSON.stringify(lastState)}`);
}

function isTerminalHost(host, href) {
  // auth.openai.com is an intermediate redirect (login / callback); the real
  // end-state is platform.openai.com or chatgpt.com where Codex CLI receives
  // the token via callback.
  if (/^platform\.openai\.com$/i.test(host)) return true;
  if (/^chatgpt\.com$/i.test(host)) return true;
  // A very small set of auth.openai.com callback URLs mean we are done.
  if (/^auth\.openai\.com$/i.test(host) && /(?:\/codex\/device\/(?:callback|success)|\/deviceauth\/callback)/i.test(href || '')) return true;
  // The non-device browser flow redirects to a local server started by
  // `codex login` (no --device-auth). Recognize that as terminal as well.
  if (/^localhost(:\d+)?$/i.test(host) && /(?:\/auth\/callback|\/success)/i.test(href || '')) return true;
  return false;
}

function isCodexConsentPage(host, pathname) {
  return host === 'auth.openai.com' && pathname === '/sign-in-with-chatgpt/codex/consent';
}

async function handleCodexConsentPage(page, mark) {
  const url = new URL(page.url());
  if (!isCodexConsentPage(url.host, url.pathname)) return false;
  mark('codex_consent_page');
  const state = await navEval(page, () => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
    const btn = candidates.find((el) => /continue/i.test((el.innerText || el.textContent || el.value || '').trim()));
    if (!btn) return { found: false };
    const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.getAttribute('disabled') !== null;
    return { found: true, disabled, text: (btn.innerText || btn.textContent || btn.value || '').trim().slice(0, 40) };
  }, { found: false });
  if (!state.found) return false;
  if (state.disabled) {
    const e = new Error('CODEX_DEVICE_AUTH_DISABLED: ChatGPT Security Settings require enabling "Device code authorization for Codex" before Codex CLI can sign in');
    e.code = 'CODEX_DEVICE_AUTH_DISABLED';
    throw e;
  }
  await waitForEnabledThenClick(page, /continue/i);
  mark('codex_consent_clicked');
  // The non-device flow redirects to a local server; the device flow
  // redirects back to auth.openai.com. Wait for either terminal URL.
  const current = page.url();
  const cur = URL.canParse(current) ? new URL(current) : null;
  if (cur && isTerminalHost(cur.host, cur.href)) return true;
  try {
    await page.waitForURL((url) => isTerminalHost(url.host, url.href), { timeout: 180000 });
    return true;
  } catch (e) {
    const final = page.url();
    throw new Error(`post-consent: no terminal redirect in 180s (final=${final})`);
  }
}

export async function establishGoogleSession({
  page, login, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  mark('google_prelogin_goto');
  await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'commit' });
  await humanIdlePause('deliberate');
  await enterGoogleCredentials({ page, login, mark, humanFill, humanClickLocator, humanIdlePause, humanType });
}

// Email -> password -> 2FA entry on accounts.google.com. Extracted verbatim
// from establishGoogleSession so it can be reused when a first-time account is
// entered via "Use another account" on the authorize chooser.
async function enterGoogleCredentials({
  page, login, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  mark('google_email');
  // Video evidence (2026-05-17): visible-wait passed the moment the
  // input rendered, but Google's WIZ controller binds the keydown
  // handlers a tick later, so humanFill's CDP keystrokes landed in a
  // not-yet-live field and the value stayed empty across the whole run.
  // Gate on editable+enabled (Playwright's `editable` waits past WIZ
  // hydration) and then verify the typed value actually landed; retype
  // up to 3 times if Google ate the keys.
  // Google sign-in v2 renders the identifier field as input[type="text"]
  // with autocomplete="username webauthn" (id="identifierId") rather than
  // type="email". Match either variant so the locator survives A/B changes.
  const gEmailIn = page.locator(
    'input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]'
  ).filter({ visible: true }).first();
  await gEmailIn.waitFor({ state: 'visible' });
  await fillAndVerify(page, gEmailIn, login.email, humanClickLocator, humanType);
  // Google's WIZ Next button enables only after the input's blur+change
  // event chain runs through their validator. fillAndVerify's
  // native-setter path dispatches input+change, but blur is needed for
  // the on-blur validator. Dispatch a focusout/blur, then verify the
  // button is actually enabled before clicking — otherwise the click
  // is a no-op against a disabled control.
  // best-effort blur — if the page has already navigated (Google
  // auto-submits some flows), the evaluate fails with
  // "Execution context was destroyed" which is HARMLESS; the
  // navigation we wanted is already happening. Catch and continue.
  try {
    await gEmailIn.evaluate((el) => {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
  } catch (e) {
    if (!e.message.includes('Execution context was destroyed')) throw e;
  }
  await humanIdlePause('short');
  await waitForEnabledThenClick(page, /next|continue|dalej/i);
  await humanIdlePause('deliberate');

  mark('google_password');
  // Google shows EITHER the password field OR a "Couldn't sign you in / browser
  // may not be secure" block. With the humanized click above this should now
  // clear; if Google still blocks, fail fast with a distinct BROWSER_NOT_SECURE
  // signal (caught by login.mjs -> reauth rotates the LRU row) instead of
  // waiting 30s for a password field that will never render.
  const gPwIn = page.locator('input[type="password"]').filter({ visible: true }).first();
  const blocked = page.getByText(/Couldn.?t sign you in|may not be secure/i).first();
  let sawPw = false;
  for (let i = 0; i < 40; i += 1) {
    if (await gPwIn.isVisible().catch(() => false)) { sawPw = true; break; }
    if (await blocked.isVisible().catch(() => false)) {
      const e = new Error('BROWSER_NOT_SECURE: Google blocked this exit at sign-in');
      e.code = 'BROWSER_NOT_SECURE';
      throw e;
    }
    await page.waitForTimeout(500); // allow-raw-playwright: password-or-block poll, not a humanized action
  }
  if (!sawPw) throw new Error('google_password: neither password field nor block page appeared');
  await fillAndVerify(page, gPwIn, login.password, humanClickLocator, humanType);
  try {
    await gPwIn.evaluate((el) => {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
    });
  } catch (e) {
    if (!e.message.includes('Execution context was destroyed')) throw e;
  }
  await humanIdlePause('short');
  await waitForEnabledThenClick(page, /next|sign in|continue|dalej/i);
  await humanIdlePause('long');

  mark('google_2fa_check');
  const otpSel = 'input[type="tel"][autocomplete="one-time-code"], input[name="totpPin"], input[autocomplete="one-time-code"]';
  const gOtp = () => page.locator(otpSel).filter({ visible: true }).first();
  const waitOtp = async (ms) => {
    try { await gOtp().waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; }
  };
  let otpVisible = await waitOtp(15000);
  if (!otpVisible) {
    // DIAGNOSTIC: dump what is actually on screen so the selector can be fixed
    // without guessing. Logs the URL path + visible clickable labels (Google UI
    // chrome text — account emails/codes are not button labels, so no secrets).
    try {
      const diag = await page.evaluate(() => {
        const texts = [];
        for (const el of Array.from(document.querySelectorAll('button,[role="button"],a,li,span,div'))) {
          const t = (el.innerText || el.textContent || '').trim();
          if (!t || t.length > 45) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          if (!texts.includes(t)) texts.push(t);
          if (texts.length >= 25) break;
        }
        return { path: location.pathname, host: location.host, texts };
      });
      console.log(`[google_sso] 2fa-diag host=${diag.host} path=${diag.path} clickables=${JSON.stringify(diag.texts)}`);
    } catch (e) { console.log(`[google_sso] 2fa-diag failed: ${e.message.slice(0, 80)}`); }
    // No code field yet. Either Google defaulted to push/SMS (switch to the
    // authenticator method to force a TOTP field) or this account has no 2FA
    // (no method-chooser present) — then there is nothing to answer.
    const switched = await selectAuthenticatorMethod(page);
    if (!switched) {
      console.log('[google_sso] no 2fa method-chooser — treating as no 2FA on this account');
      return;
    }
    console.log('[google_sso] selected authenticator (TOTP) method via "Try another way"');
    otpVisible = await waitOtp(15000);
    if (!otpVisible) {
      const err = new Error('google 2FA: authenticator selected but no code field appeared');
      err.fatal2fa = true;
      throw err;
    }
  }
  // A code field is showing — it MUST be answered now. Aborting here (rather
  // than falling through) prevents the authorize->chooser->re-enter loop from
  // re-submitting the password and re-triggering another push/SMS to the user.
  const otp = resolveOtp(login);
  if (!otp) {
    const err = new Error('google 2FA required but no login.totpSecret and no CODEX_2FA_CODE — aborting to avoid re-triggering push/SMS');
    err.fatal2fa = true;
    throw err;
  }
  await humanFill(page, gOtp(), otp);
  await humanClickLocator(page, page.locator('#totpNext button, button:has-text("Next"), button[type="submit"]').filter({ visible: true }).first());
  await humanIdlePause('long');
}

export async function doGoogleSso({
  page, login, authorizeUrl, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  await establishGoogleSession({ page, login, mark, humanFill, humanClickLocator, humanIdlePause, humanType });

  mark('goto_authorize');
  await page.goto(authorizeUrl, { waitUntil: 'commit' });
  await humanIdlePause('deliberate');

  mark('gis_continue');
  // GIS handoff is non-deterministic (popup | in-page consent |
  // Loading | blank). Bounded state machine: poll for a terminal
  // marker; if none, reload authorizeUrl and retry.
  // retry-allowed: bounded recovery for the non-deterministic claude.ai GIS handoff, not a flaky retry.
  let popupPage = null;
  let chooserFreshTried = false;
  const onPopup = (p) => { if (!popupPage) popupPage = p; };
  page.context().on('page', onPopup);
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { await waitForEnabledThenClick(page, /continue with google|^google$/i); }
      catch (e) { console.log(`[google_sso] no continue-with-google a${attempt}: ${e.message.slice(0, 50)}`); }
      let popupHandled = false;
      for (let i = 0; i < 200; i += 1) {
        if (popupPage && !popupHandled) {
          popupHandled = true;
          console.log(`[google_sso] GIS popup: ${popupPage.url()}`);
          await popupPage.waitForLoadState('domcontentloaded');
          mark('gis_account_chooser_popup');
          await clickEmailRow(popupPage, login.email);
          await humanIdlePause('long');
          try { await waitForEnabledThenClick(popupPage, /^(continue|dalej|next)$/i); }
          catch (e) { console.log(`[google_sso] no popup consent: ${e.message.slice(0, 50)}`); }
        }
        const st = await navEval(page, () => {
          const b = Array.from(document.querySelectorAll('button,[role="button"]'));
          const c = b.find((x) => /^(authorize|allow)$/i.test((x.innerText || x.textContent || '').trim())
            && !(x.disabled || x.getAttribute('aria-disabled') === 'true'));
          return { host: location.host, pathname: location.pathname, href: location.href, consent: !!c };
        }, { host: '', pathname: '', href: '', consent: false });
        if (await handleCodexConsentPage(page, mark)) { mark('openai_callback'); return page; }
        if (isTerminalHost(st.host, st.href)) { mark('openai_callback'); return page; }
        // In-page Google account chooser (happens when GIS has a session but
        // needs the user to pick the account). Select the configured email,
        // then click Continue to reach the OAuth consent page.
        if (st.host === 'accounts.google.com' && /accountchooser|identifier/.test(st.pathname)) {
          try {
            await clickEmailRow(page, login.email);
            mark('gis_account_chooser');
            await humanIdlePause('long');
            await waitForEnabledThenClick(page, /^(continue|dalej|next)$/i);
            await humanIdlePause('long');
          } catch (e) {
            console.log(`[google_sso] accountchooser handling (path=${st.pathname}): ${e.message.slice(0, 120)}`);
            // First-time account: no matching chooser row. Two page shapes are
            // possible: (a) a row chooser needing "Use another account", or (b)
            // the identifier (email-input) page with no rows at all. Try the
            // button (harmless no-op on shape b), then always try entering the
            // account fresh (fills the email input on either shape). Once only.
            if (!chooserFreshTried) {
              chooserFreshTried = true;
              try { await clickUseAnotherAccount(page); mark('gis_use_another_account'); await humanIdlePause('long'); }
              catch (e2) { console.log(`[google_sso] no use-another-account (path=${st.pathname}): ${e2.message.slice(0, 80)}`); }
              try {
                await enterGoogleCredentials({ page, login, mark, humanFill, humanClickLocator, humanIdlePause, humanType });
                await humanIdlePause('long');
              } catch (e3) {
                if (e3 && e3.fatal2fa) throw e3; // abort — do not loop back and re-trigger push/SMS
                console.log(`[google_sso] fresh-entry failed (path=${st.pathname}): ${e3.message.slice(0, 120)}`);
              }
            }
          }
          continue;
        }
        if (st.consent) {
          mark('oauth_consent_click');
          await waitForEnabledThenClick(page, /^(authorize|allow|continue|dalej|next)$/i);
          // Consent granted: Google redirects to auth.openai.com, which then
          // redirects to platform.openai.com/chatgpt.com. Wait for any OpenAI
          // terminal host; do NOT reload authorizeUrl (it would re-trigger the
          // consent flow). Single bounded wait.
          for (let k = 0; k < 1800; k += 1) {
            const h = await navEval(page, () => location.host, '');
            if (isTerminalHost(h, '')) { mark('openai_callback'); return page; }
            await page.waitForTimeout(100); // allow-raw-playwright: post-consent redirect poll
          }
          throw new Error('post-consent: no OpenAI redirect in 180s');
        }
        await page.waitForTimeout(100); // allow-raw-playwright: terminal-state poll
      }
      console.log(`[google_sso] no terminal state a${attempt}; reloading authorizeUrl`);
      await page.goto(authorizeUrl, { waitUntil: 'commit' });
      await humanIdlePause('deliberate');
    }
    const d = await navEval(page, () => ({ url: location.href, body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 220) }), { url: '?', body: 'context destroyed' });
    throw new Error(`gis_continue: no consent/code after 4 attempts diag=${JSON.stringify(d)}`);
  } finally {
    page.context().off('page', onPopup);
  }
}

// Click the Google account-chooser row matching the given email.
// The row is a div, not a button, so waitForEnabledThenClick won't
// find it. DOM-walk for any element whose visible text contains
// the email, take its bounding-box center, CDP-click.
async function clickEmailRow(page, email) {
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
