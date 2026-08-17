// Google-SSO sub-flow for the claude login trajectory.
//
// ROOT CAUSE (live SSH evidence): claude.ai's "Continue with Google" is a
// Google Identity Services (GIS) button, not a classic OAuth redirect.
// Clicking it with no Google session logs "Provider's accounts list is
// empty." and does nothing (no popup, no nav). So we must establish a
// Google session at accounts.google.com FIRST, then load claude.ai's
// authorize URL — GIS then has an account and the click completes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { humanClick } from '../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

// Diagnostic slice sizes for the state read below, and the smallest box that
// counts as a rendered control. A 1x1 tracking pixel with role="button" is not
// an affordance; 4px is the same floor waitForEnabledThenClick uses.
const GIS_MIN_BOX_PX = 4;
const GIS_DIAG_URL_CHARS = 300;
const GIS_DIAG_TITLE_CHARS = 120;
const GIS_DIAG_BODY_CHARS = 240;

// RFC 6238 TOTP (SHA1, 6-digit, 30s) from a base32 secret; verified vs RFC vectors.
function b32decode(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';const clean=String(s).replace(/=+$/,'').toUpperCase().replace(/\s/g,'');let bits='';const out=[];for(const c of clean){const v=A.indexOf(c);if(v<0)continue;bits+=v.toString(2).padStart(5,'0');}for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(out);}
function totp(secretB32,forTime=Date.now(),digits=6,step=30){const key=b32decode(secretB32);let tt=Math.floor((forTime/1000)/step);const buf=Buffer.alloc(8);for(let i=7;i>=0;i-=1){buf[i]=tt&0xff;tt=Math.floor(tt/256);}const h=crypto.createHmac('sha1',key).update(buf).digest();const o=h[h.length-1]&0xf;const n=((h[o]&0x7f)<<24)|((h[o+1]&0xff)<<16)|((h[o+2]&0xff)<<8)|(h[o+3]&0xff);return String(n%(10**digits)).padStart(digits,'0');}
function resolveOtp(login){if(login&&login.totpSecret){try{return totp(login.totpSecret);}catch(e){console.log(`[google_sso] totp gen failed: ${e.message}`);}}return process.env.CLAUDE_2FA_CODE||null;}
async function selectAuthenticatorMethod(page) {
  // Click the SMALLEST visible element matching `matchSrc`. Exact mode anchors
  // the whole label (so "Try another way" never matches a parent card whose
  // text is "Resend it\nTry another way" — clicking that centered the wrong
  // control and re-sent the push). Smallest-box preference picks the leaf.
  const clickBest = async (matchSrc, mode, maxTries) => {
    for (let i = 0; i < maxTries; i += 1) {
      const hit = await page.evaluate(([src, m]) => {
        const rx = new RegExp(src, 'i');
        let best = null;
        for (const el of Array.from(document.querySelectorAll('button,[role="button"],a,li,span,div,[role="link"]'))) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (!txt || txt.length > 70) continue;
          if (!rx.test(txt)) continue;
          if (m === 'exact' && txt.length > 30) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          const area = r.width * r.height;
          if (!best || area < best.area) best = { x: r.x + r.width / 2, y: r.y + r.height / 2, area };
        }
        return best;
      }, [matchSrc, mode]);
      if (hit) { await humanClick(page, Math.round(hit.x), Math.round(hit.y)); return true; }
      await page.waitForTimeout(150); // allow-raw-playwright: challenge-render poll
    }
    return false;
  };
  // Every Google 2FA page is labelled "2-Step Verification"; absent it, there
  // is no challenge to answer.
  const challengePresent = await page.evaluate(() =>
    /2-step verification|weryfikacja dwuetapowa/i.test(document.body ? document.body.innerText : ''));
  if (!challengePresent) return 'no-2fa';
  const opened = await clickBest('^try another way$|^wyprobuj inny sposob$|^more ways to verify$', 'exact', 30);
  if (!opened) return 'stuck';
  await page.waitForTimeout(1200); // allow-raw-playwright: method-list render
  try {
    const opts = await page.evaluate(() => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll('li,[role="link"],[role="button"],div'))) {
        const t = (el.innerText || el.textContent || '').trim();
        if (!t || t.length > 70 || out.includes(t)) continue;
        out.push(t); if (out.length >= 20) break;
      }
      return { path: location.pathname, texts: out };
    });
    console.log(`[google_sso] 2fa-methods path=${opts.path} options=${JSON.stringify(opts.texts)}`);
  } catch (e) { console.log(`[google_sso] 2fa-methods diag failed: ${e.message.slice(0, 80)}`); }
  const picked = await clickBest('authenticator|verification code from|google authenticator', 'contains', 20);
  if (!picked) return 'stuck';
  await page.waitForTimeout(1000); // allow-raw-playwright: otp-field render
  return 'switched';
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
      await humanClick(page, Math.round(lastState.x), Math.round(lastState.y));
      return;
    }
    await page.waitForTimeout(100); // allow-raw-playwright: enable-state poll, not a humanized action
  }
  throw new Error(`waitForEnabledThenClick: button stuck unclickable for /${patternSrc}/i, lastState=${JSON.stringify(lastState)}`);
}

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
  await waitForEnabledThenClick(page,/next|continue|dalej/i);
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
  await waitForEnabledThenClick(page,/next|sign in|continue|dalej|zaloguj/i);
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
    const result = await selectAuthenticatorMethod(page);
    if (result === 'no-2fa') {
      console.log('[google_sso] no 2fa challenge present — nothing to answer');
      return;
    }
    if (result === 'stuck') {
      const err = new Error('google 2FA present but could not switch to authenticator — aborting to avoid push/sms loop');
      err.fatal2fa = true;
      throw err;
    }
    console.log('[google_sso] selected authenticator (TOTP) method via "Try another way"');
    otpVisible = await waitOtp(15000);
    if (!otpVisible) {
      const err = new Error('google 2FA: authenticator selected but no code field appeared');
      err.fatal2fa = true;
      throw err;
    }
  }
  const otp = resolveOtp(login);
  if (!otp) {
    const err = new Error('google 2FA required but no login.totpSecret and no CLAUDE_2FA_CODE — aborting to avoid re-triggering push/SMS');
    err.fatal2fa = true;
    throw err;
  }
  await humanFill(page, gOtp(), otp);
  await humanClickLocator(page, page.locator('#totpNext button, button:has-text("Next"), button[type="submit"]').filter({ visible: true }).first());
  await humanIdlePause('long');
}

// Bounds for the GIS handoff. The step is governed by one deadline and by what
// the pages report, never by a count of attempts: the old fixed 4-attempt loop
// clicked the button again while Google's chooser was still sitting in a popup
// nobody was driving. The debounce stops an unchanged state from being clicked
// on every poll, and the settle window keeps a claude.ai login gate from being
// re-clicked during the instant between the click and the popup appearing.
const GIS_DEADLINE_MS = Number(process.env.CLAUDE_GIS_DEADLINE_MS || 300000);
const GIS_POLL_MS = Number(process.env.CLAUDE_GIS_POLL_MS || 250);
const GIS_ACTION_DEBOUNCE_MS = Number(process.env.CLAUDE_GIS_ACTION_DEBOUNCE_MS || 6000);
const GIS_GATE_SETTLE_MS = Number(process.env.CLAUDE_GIS_GATE_SETTLE_MS || 2500);

// Highest priority first. A live Google page always outranks the parent's
// "Continue with Google" gate, because the parent still shows that gate while
// the popup holds the account decision — that is exactly the pair of states the
// 2026-08-17 run mistook for "nothing happened" and re-clicked.
const GIS_VARIANT_PRIORITY = [
  'code_page',
  'oauth_consent',
  'google_rejected',
  'google_account_chooser',
  'google_chooser_without_account',
  'google_identifier',
  'google_password',
  'google_scope_consent',
  'google_challenge',
  'google_other',
  'claude_gis_gate',
  'unknown',
];

// Rank of a state. Exported with classifyGisState because the two together are
// the whole definition of "which page owns the decision right now", and the
// failure message names those same states — a diagnostic that disagrees with
// the trajectory about them would be worse than no diagnostic.
export function gisVariantRank(variant) {
  const i = GIS_VARIANT_PRIORITY.indexOf(variant);
  return i < 0 ? GIS_VARIANT_PRIORITY.length : i;
}

// One read of one page: everything the state machine decides on, collected in a
// single evaluate so the facts cannot disagree with each other. Element centres
// come back as points because every click goes through humanClick.
//
// Exported as a standalone function of its argument (no closure over module
// state) so a recorded DOM snapshot can be replayed through the exact code the
// live run uses — this surface is diagnosed from recorded DOM, so the reading of
// that DOM must not be a second implementation.
export const readGisState = (arg) => {
  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= arg.minBox && r.height >= arg.minBox;
  };
  const live = (el) => !(el.disabled
    || el.getAttribute('aria-disabled') === 'true'
    || el.getAttribute('disabled') !== null);
  const pick = (selector, re) => {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!shown(el) || !live(el)) continue;
      if (re && !re.test((el.innerText || el.textContent || '').trim())) continue;
      return centre(el);
    }
    return null;
  };

  // The account row is a div[role=link] carrying data-identifier="<email>"
  // (proven by the recorded chooser document); the label beside it is not
  // usable, the page renders in the account's own language.
  const rows = Array.from(document.querySelectorAll('[role="link"][jsname], [data-identifier]'))
    .filter((el) => shown(el));
  const identified = rows.filter((el) => el.getAttribute('data-identifier'));
  const mine = identified.find((el) => el.getAttribute('data-identifier') === arg.email)
    // Fallback for a chooser that renders the address as text only.
    || rows.find((el) => (el.innerText || el.textContent || '').includes(arg.email));
  const others = rows.filter((el) => el !== mine && !el.getAttribute('data-identifier'));

  return {
    ok: true,
    url: location.href.slice(0, arg.maxUrl),
    host: location.host,
    pathname: location.pathname,
    title: (document.title || '').slice(0, arg.maxTitle),
    rowCount: rows.length,
    accountRow: mine ? centre(mine) : null,
    otherAccountRow: others.length ? centre(others[0]) : null,
    // claude.ai's own grant screen.
    consent: pick('button,[role="button"]', /^(authorize|allow)$/i),
    // Google's scope screen. Its primary control is identified structurally
    // first (#submit_approve_access is Google's own id) and only then by
    // wording, because the surface is localized.
    googlePrimary: pick('#submit_approve_access button, #submit_approve_access, [data-primary-action-label] button')
      || pick('button,[role="button"]', /^(continue|allow|confirm|next|kontynuuj|zezwól|potwierdź|dalej)$/i),
    gisButton: pick('button,[role="button"]', /continue with google|^google$/i),
    // The same identifier-field variants enterGoogleCredentials types into, so
    // the state read and the action cannot disagree about which page this is.
    identifierField: Boolean(document.querySelector('input[type="text"][autocomplete*="username"], input#identifierId, input[name="identifier"], input[type="email"]')),
    passwordField: Boolean(document.querySelector('input[type="password"]')),
    bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, arg.maxBody),
  };
};

// Read one live page through that probe. A navigation mid-read means "not ready,
// look again", which navEval already turns into the null default.
async function observeGisPage(p, email) {
  return navEval(p, readGisState, null, {
    email,
    minBox: GIS_MIN_BOX_PX,
    maxUrl: GIS_DIAG_URL_CHARS,
    maxTitle: GIS_DIAG_TITLE_CHARS,
    maxBody: GIS_DIAG_BODY_CHARS,
  });
}

// Name the state the page is in. Every name here is either proven by the
// 2026-08-17 recording or is a Google sign-in surface this file already drives
// elsewhere; anything else stays 'unknown' and ends up in the failure message
// rather than being guessed at.
export function classifyGisState(st) {
  if (!st || !st.ok) return 'unknown';
  if (st.host === 'platform.claude.com') return 'code_page';
  if (st.host === 'accounts.google.com') {
    if (/\/signin\/rejected|deniedsigninrejected/.test(st.pathname)) return 'google_rejected';
    if (st.accountRow) return 'google_account_chooser';
    if (/accountchooser|oauthchooseaccount/.test(st.pathname) && st.rowCount > 0) return 'google_chooser_without_account';
    // Identifier first: the sign-in flow this file drives starts at the email
    // field, so a page offering both fields is an identifier page. A page with
    // only a password field is Google re-verifying an existing session, which
    // this step does not drive — it is named in the failure instead of guessed.
    if (st.identifierField) return 'google_identifier';
    if (st.passwordField) return 'google_password';
    if (/\/signin\/(oauth|consent)|\/o\/oauth2\//.test(st.pathname) && st.googlePrimary) return 'google_scope_consent';
    if (/\/signin\/(v2\/)?challenge/.test(st.pathname)) return 'google_challenge';
    return 'google_other';
  }
  if (st.consent) return 'oauth_consent';
  if (st.gisButton) return 'claude_gis_gate';
  return 'unknown';
}

// Write the DOM of every live page next to the run's other recordings and
// return the paths. The 2026-08-17 investigation had to reconstruct the popup
// from session.har because the only DOM snapshot was the parent page's; a
// failure here now leaves the popup's own DOM on disk.
async function dumpGisFailureDom(pages, variant) {
  const dir = runRecordingsDir(process.env.ACTION || 'claude_login');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const written = [];
  for (let i = 0; i < pages.length; i += 1) {
    const { p, st, variant: v } = pages[i];
    if (p.isClosed()) continue;
    let html = null;
    try { html = await p.content(); } catch { html = null; }
    if (typeof html !== 'string') continue;
    const path = join(dir, `gis_unhandled_${variant}_p${i}_${v}_${stamp}.html`);
    try {
      writeFileSync(path, html);
      written.push({ path, url: st?.url ?? null, title: st?.title ?? null, variant: v });
    } catch { /* a closed page or a full disk must not mask the real failure */ }
  }
  const indexPath = join(dir, `gis_unhandled_${variant}_${stamp}.json`);
  try { writeFileSync(indexPath, JSON.stringify({ variant, pages: written }, null, 2)); }
  catch { /* same */ }
  return { indexPath, written };
}

export async function doGoogleSso({
  page, login, authorizeUrl, mark,
  humanFill, humanClickLocator, humanIdlePause, humanType,
}) {
  mark('google_prelogin_goto');
  await page.goto('https://accounts.google.com/ServiceLogin?hl=en', { waitUntil: 'commit' });
  await humanIdlePause('deliberate');

  await enterGoogleCredentials({ page, login, mark, humanFill, humanClickLocator, humanIdlePause, humanType });

  // Session established. Now load claude.ai's OAuth — GIS sees the account.
  mark('goto_authorize');
  await page.goto(authorizeUrl, { waitUntil: 'commit' });
  await humanIdlePause('deliberate');

  mark('gis_continue');
  // How this handoff actually behaves, from the recorded run
  // e9b443eb-8e50-4836-a5a6-6671af07cbd2 (claude_login, 2026-08-17T01:03:49Z to
  // 01:07:56Z) under the worker's recordings root: its session.har lists five
  // pages — the trajectory's page plus four popups titled "Logowanie – Konta
  // Google" opened at 01:05:13, 01:05:55, 01:06:36 and 01:07:17, one per click
  // of "Continue with Google". GIS opens them with
  // prompt=select_account%20consent&display=popup, so Google renders its
  // account chooser there every time, and the popup's own document
  // (/v3/signin/accountchooser, embedded in that HAR) carries the row as
  // <div role="link" jsname="MBVUVe" data-identifier="controlyourai@gmail.com"
  // data-button-type="multipleChoiceIdentifier"> in Polish, with no continue
  // button at all — clicking the row IS the action. The step that failed closed
  // the first popup, then polled only the parent, which claude.ai had bounced to
  // /login?selectAccount=true&returnTo=%2Foauth%2Fauthorize... — the state
  // session_dom_20260816_180756.html shows. Popups two to four were never
  // adopted (the listener kept only the first) and sat unattended on the
  // chooser. So: never close the popup, read every live page each poll, act on
  // the state that page is in, and select the account by data-identifier
  // instead of by localized text.
  const seen = new WeakSet();
  const onPopup = (p) => { if (!seen.has(p)) { seen.add(p); mark('gis_popup'); } };
  page.context().on('page', onPopup);
  const deadline = Date.now() + GIS_DEADLINE_MS;
  let freshEntryTried = false;
  let lastAction = { key: '', at: 0 };
  let gateSince = 0;
  let views = [];
  try {
    while (Date.now() < deadline) {
      views = [];
      for (const p of page.context().pages()) {
        if (p.isClosed()) continue;
        const st = await observeGisPage(p, login.email);
        views.push({ p, st, variant: classifyGisState(st) });
      }
      views.sort((a, b) => gisVariantRank(a.variant) - gisVariantRank(b.variant));
      const view = views[0];
      if (!view) { await page.waitForTimeout(GIS_POLL_MS); continue; } // allow-raw-playwright: state poll, not a humanized action
      const { p: active, st, variant } = view;

      if (variant === 'code_page') { mark('code_page'); return active; }

      // Acting twice on a state that has not changed yet is what produced the
      // popup pile-up, so an identical (variant, url) is acted on at most once
      // per debounce window.
      const actionKey = `${variant}|${st?.url ?? ''}`;
      const fresh = actionKey !== lastAction.key || Date.now() - lastAction.at >= GIS_ACTION_DEBOUNCE_MS;
      const claim = () => { lastAction = { key: actionKey, at: Date.now() }; };

      if (variant === 'claude_gis_gate') {
        // The gate is only meaningful while no Google page is holding the
        // decision; otherwise clicking it opens yet another popup.
        const googleOpen = views.some((v) => v.variant.startsWith('google'));
        if (googleOpen) { gateSince = 0; await active.waitForTimeout(GIS_POLL_MS); continue; } // allow-raw-playwright: state poll
        if (!gateSince) gateSince = Date.now();
        if (Date.now() - gateSince >= GIS_GATE_SETTLE_MS && fresh) {
          claim();
          mark('gis_click_continue');
          await humanClick(active, Math.round(st.gisButton.x), Math.round(st.gisButton.y));
          await humanIdlePause('deliberate');
        } else {
          await active.waitForTimeout(GIS_POLL_MS); // allow-raw-playwright: settle poll
        }
        continue;
      }
      gateSince = 0;

      if (!fresh) { await active.waitForTimeout(GIS_POLL_MS); continue; } // allow-raw-playwright: debounce poll

      if (variant === 'google_rejected') {
        const dump = await dumpGisFailureDom(views, variant);
        throw new Error(`gis_continue: Google refused this sign-in (variant 'google_rejected') at ${st.host}${st.pathname}; body="${st.bodyText}"; DOM snapshot: ${dump.written[0]?.path ?? dump.indexPath}`);
      }

      if (variant === 'google_account_chooser') {
        claim();
        mark('gis_account_chooser');
        await humanClick(active, Math.round(st.accountRow.x), Math.round(st.accountRow.y));
        await humanIdlePause('long');
        continue;
      }

      if (variant === 'google_chooser_without_account') {
        // The signed-in session is not the account we need: take the chooser's
        // other row ("use another account"), which lands on the identifier page
        // handled below.
        if (!st.otherAccountRow) { await active.waitForTimeout(GIS_POLL_MS); continue; } // allow-raw-playwright: state poll
        claim();
        mark('gis_use_another_account');
        await humanClick(active, Math.round(st.otherAccountRow.x), Math.round(st.otherAccountRow.y));
        await humanIdlePause('long');
        continue;
      }

      if (variant === 'google_identifier') {
        if (freshEntryTried) { await active.waitForTimeout(GIS_POLL_MS); continue; } // allow-raw-playwright: state poll
        claim();
        freshEntryTried = true;
        try {
          await enterGoogleCredentials({ page: active, login, mark, humanFill, humanClickLocator, humanIdlePause, humanType });
          await humanIdlePause('long');
        } catch (e) {
          if (e && e.fatal2fa) throw e;
          console.log(`[google_sso] fresh-entry failed in popup (path=${st.pathname}): ${e.message.slice(0, 120)}`);
        }
        continue;
      }

      if (variant === 'google_scope_consent') {
        claim();
        mark('gis_scope_consent');
        await humanClick(active, Math.round(st.googlePrimary.x), Math.round(st.googlePrimary.y));
        await humanIdlePause('long');
        continue;
      }

      if (variant === 'oauth_consent') {
        claim();
        mark('oauth_consent_click');
        await humanClick(active, Math.round(st.consent.x), Math.round(st.consent.y));
        // The SPA POSTs /v1/oauth/.../authorize (slow in headless, renders a
        // spinner) and then redirects to platform.claude.com. That redirect is
        // just another state this same loop observes, so there is no separate
        // wait to get out of sync with; the deadline governs it.
        await humanIdlePause('long');
        continue;
      }

      // 'google_password', 'google_challenge', 'google_other' and 'unknown' are
      // states this step does not drive: keep watching until the deadline, then
      // report the state by name with the DOM that shows it.
      await active.waitForTimeout(GIS_POLL_MS); // allow-raw-playwright: state poll
    }

    const stuck = views[0];
    const variant = stuck?.variant ?? 'no_live_page';
    const dump = await dumpGisFailureDom(views, variant);
    const where = stuck?.st ? `${stuck.st.host}${stuck.st.pathname} title="${stuck.st.title}"` : 'no live page';
    const evidence = dump.written.map((w) => w.path).join(', ') || dump.indexPath;
    throw new Error(`gis_continue: unhandled variant '${variant}' at ${where} after ${Math.round(GIS_DEADLINE_MS / 1000)}s; live pages=${views.map((v) => v.variant).join('+') || 'none'}; DOM snapshot: ${evidence}`);
  } finally {
    page.context().off('page', onPopup);
  }
}
