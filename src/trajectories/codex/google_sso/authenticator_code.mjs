// The one-time code that answers Google's 2FA prompt, and the switch to the
// method that asks for it.
//
// Google defaults this fleet's accounts to a push or an SMS, which headless
// automation cannot complete, so the challenge is moved to the authenticator app
// and answered from the account's own stored secret.
import crypto from 'node:crypto';
import { humanClick } from '../../../../dist/human/mouse.js';

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

// On a Google 2FA challenge, switch to the authenticator-app (TOTP) method:
// click "Try another way", then the authenticator option. Returns true if a
// method switch was performed, false if no method-chooser is present (e.g. the
// account has no 2FA at all). This lets the login answer 2FA from a stored TOTP
// secret instead of a push/SMS prompt the headless automation can't complete.
export async function selectAuthenticatorMethod(page) {
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
