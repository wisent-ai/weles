// The one-time code that answers Google's 2FA prompt, and the switch to the
// method that asks for it.
//
// The credential driver handles an offered phone approval when no seed is held.
// This module selects the authenticator when that account can answer its code.
import crypto from 'node:crypto';
import { humanClick, humanClickLocator } from '../../../../dist/human/mouse.js';
import { navEval } from './page_controls.mjs';
import { pageCondition, pageSettled } from '../../_shared/page/settled.mjs';

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
// A live TOTP from login.totpSecret when the account carries one; otherwise the
// code the operator supplied in CODEX_2FA_CODE. A stored secret that cannot be
// turned into a code is a broken credential and says so rather than quietly
// handing the prompt to the operator's env. Returns null when the account has no
// secret and no code was supplied.
export function resolveOtp(login) {
  if (login && login.totpSecret) return totp(login.totpSecret);
  return process.env.CODEX_2FA_CODE || null;
}

async function googleChallengeState(page, terminalOnly = false) {
  const read = (waitForTerminal) => {
    const observed = {
      host: location.host,
      path: location.pathname,
      challenge: location.hostname === 'accounts.google.com'
        && (/\/challenge(?:\/|$)/.test(location.pathname)
          || /2-step verification|get a code to sign in|verify it.s you|weryfikacja dwuetapowa/i.test(document.body?.innerText || '')),
    };
    if (waitForTerminal && observed.challenge) {
      let invalidInput = null;
      for (const input of document.querySelectorAll('input[name="totpPin"][aria-invalid="true"], input[autocomplete="one-time-code"][aria-invalid="true"]')) {
        const rect = input.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && getComputedStyle(input).visibility === 'visible') {
          invalidInput = {
            name: input.name,
            autocomplete: input.getAttribute('autocomplete'),
            ariaInvalid: input.getAttribute('aria-invalid'),
          };
          break;
        }
      }
      if (!invalidInput) return false;
      observed.invalidInput = invalidInput;
    }
    observed.text = (document.querySelector('main')?.innerText || document.body?.innerText || '')
      .replace(/\s+/g, ' ');
    return observed;
  };
  if (terminalOnly) return pageCondition(page, read, true);
  return navEval(page, read, { challenge: null, state: 'navigation in progress' }, false);
}

function challengeFailure(code, message, observed) {
  const error = new Error(`${message}: ${JSON.stringify(observed)}`);
  error.code = code;
  error.fatal2fa = true;
  if (observed?.challenge === true) error.second_factor = { required: true, method: null };
  return error;
}

// A missing seed has one structured outcome whether the code field is already
// visible or Google first presents a method chooser. Brama consumes the code,
// not a substring of the diagnostic, to start the account's recovery flow.
export async function requireAuthenticatorCode(page, code) {
  if (typeof code === 'string' && code.trim()) return code.trim();
  throw challengeFailure('google_2fa_material_missing',
    'The selected login has no authenticator seed or supplied verification code. '
    + 'Brama sign-in can request Weles authenticator enrolment and resume this account '
    + 'after the seed is confirmed; any required phone approval appears in Weles operator requests.',
    await googleChallengeState(page));
}

// A challenge that is still displayed is pending, not evidence of refusal.
// Observe its exit or the code input's explicit invalid state; browser errors
// remain observation errors rather than being relabeled as a rejected code.
export async function waitForGoogleChallengeExit(page) {
  const observed = await googleChallengeState(page, true);
  if (observed.challenge === false) return;
  throw challengeFailure('provider_challenge_refused', 'Google marks the verification input invalid', observed);
}

// Select only an authenticator method the supplied login can answer.
export async function selectAuthenticatorMethod(page, hasCode) {
  // Click the SMALLEST visible element matching `matchSrc`. Exact mode anchors
  // the whole label (so "Try another way" never matches a parent card whose
  // text is "Resend it\nTry another way" — clicking that centered the wrong
  // control and re-sent the push). Smallest-box preference picks the leaf.
  // One look at the settled page; callers' former retry counts are ignored.
  const clickBest = async (matchSrc, mode) => {
    await pageSettled(page);
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
    if (!hit) return false;
    await humanClick(page, Math.round(hit.x), Math.round(hit.y));
    return true;
  };
  const observed = await googleChallengeState(page);
  if (observed.challenge === false) return 'no-2fa';
  if (observed.challenge === null) {
    throw challengeFailure('google_sign_in_state_unavailable', 'Google sign-in state could not be read', observed);
  }
  if (!hasCode) await requireAuthenticatorCode(page, null);
  // Google can open the method chooser directly, without another menu step.
  const offered = page.getByRole('link', { name: /Google Authenticator/i })
    .or(page.getByRole('button', { name: /Google Authenticator/i }))
    .or(page.getByRole('option', { name: /Google Authenticator/i }))
    .filter({ visible: true }).first();
  if (await offered.isVisible()) {
    await humanClickLocator(page, offered);
    await pageSettled(page);
    return 'switched';
  }
  const opened = await clickBest('^try another way$|^wyprobuj inny sposob$|^more ways to verify$', 'exact', 30);
  if (!opened) return 'stuck';
  await pageSettled(page);
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
  } catch (e) { console.log(`[google_sso] 2fa-methods diag failed: ${e.message}`); }
  const picked = await clickBest('authenticator|verification code from|google authenticator', 'contains', 20);
  if (!picked) return 'stuck';
  await pageSettled(page);
  return 'switched';
}
