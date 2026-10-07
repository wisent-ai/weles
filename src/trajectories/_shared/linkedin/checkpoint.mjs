import { CaptchaSolver } from '../../../../dist/captcha/solver.js';
import { solveRecaptchaV2 as solveRecaptchaV2InPage } from '../../../../dist/captcha/recaptcha.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { pageSettled, urlMatching } from '../page/settled.mjs';
import { humanType } from '../../../../dist/human/keyboard.js';
import { getReceived, listReceivedFrom, receivingConfigured } from '../../../_shared/resend-receiving.mjs';

const RECAPTCHA_SITEKEY = '6LcIy_MqAAAAAMKiupFSbmzW3xjGSlIfRzNWYMjC';
const CHECKPOINT_RE = /\/(checkpoint|uas\/login|login\/recovery)/;

// Detect & solve the email-PIN /checkpoint variant. LinkedIn serves this when
// a known account logs in from a new device/IP: pageKey=
// "d_checkpoint_ch_emailPinChallenge" with a 6-digit PIN input. We own
// wisentmedia.com / pilatesguild.com / dashnet102.com inboxes via Resend.
async function solveEmailPinChallenge({ page }, email) {
  const pageKey = await page.evaluate(`(()=>document.querySelector('meta[name="pageKey"]')?.content||'')()`).catch(() => '');
  if (!pageKey.includes('emailPinChallenge')) return { ok: false, reason: 'not_email_pin_challenge' };
  console.log(`[linkedin_login] emailPinChallenge detected for ${email} — fetching code from Resend`);
  if (!receivingConfigured()) return { ok: false, reason: 'no_inbox_route' };
  // Only accept emails that arrived AFTER /checkpoint was loaded — earlier
  // PINs from prior login attempts are expired. LinkedIn issues a fresh
  // 6-digit PIN per /checkpoint instance.
  // One inbox read: the receiving route has no push or blocking read, so a PIN
  // that has not arrived yet is reported by name.
  const challengeStart = Date.now();
  let code = null;
  const matches = (await listReceivedFrom(20, email, 'linkedin.com'))
    .filter((m) => new Date(m.created_at).getTime() >= challengeStart - 5000);
  const msg = matches[0];
  if (msg) {
    const m = (msg.subject || '').match(/\b(\d{6})\b/);
    if (m) { code = m[1]; console.log(`[linkedin_login] PIN ${code} from subject (sent ${msg.created_at})`); }
    else {
      const full = await getReceived(msg.id);
      const body = (full?.text || full?.html || '').match(/\b(\d{6})\b/);
      if (body) { code = body[1]; console.log(`[linkedin_login] PIN ${code} from body (sent ${msg.created_at})`); }
    }
  }
  if (!code) return { ok: false, reason: 'pin_email_not_received' };
  // Live-discover the visible inputs and buttons so we know exactly what
  // selector LinkedIn shipped this variant of the page with. Logged for
  // diagnosis on first failure.
  const inputInfo = await page.evaluate(`(()=>Array.from(document.querySelectorAll('input')).filter(i=>i.offsetParent!==null).map(i=>({name:i.name,id:i.id,type:i.type,ac:i.getAttribute('autocomplete'),maxLen:i.maxLength,ph:i.placeholder})))()`)
    .catch((error) => ({ unreadable: `the PIN page's inputs could not be read: ${error.message}` }));
  console.log(`[linkedin_login] emailPin inputs: ${JSON.stringify(inputInfo)}`);
  const buttonInfo = await page.evaluate(`(()=>Array.from(document.querySelectorAll('button')).filter(b=>b.offsetParent!==null).map(b=>({type:b.type,txt:b.innerText.trim(),id:b.id,name:b.name})))()`)
    .catch((error) => ({ unreadable: `the PIN page's buttons could not be read: ${error.message}` }));
  console.log(`[linkedin_login] emailPin buttons: ${JSON.stringify(buttonInfo)}`);
  try {
    const candidates = [
      'input[name="pin"]', 'input[id="input__email_verification_pin"]',
      'input[type="text"][autocomplete="one-time-code"]',
      'input[autocomplete="one-time-code"]',
      'input[name="email-pin"]', 'input[name*="pin" i]',
      'input[type="tel"][maxlength="6"]', 'input[type="text"][maxlength="6"]',
      'input[type="text"]:not([name="email"]):not([name="username"]):not([name="password"]):not([name="session_key"]):not([name="session_password"])',
    ];
    let filled = false;
    for (const sel of candidates) {
      const loc = page.locator(sel).filter({ visible: true }).first();
      if (await loc.count() > 0) {
        await humanClickLocator(page, loc);
        await humanType(page, code);
        console.log(`[linkedin_login] PIN filled into ${sel}`);
        filled = true; break;
      }
    }
    if (!filled) {
      // One box per digit of the PIN LinkedIn sent (pin-<n> or otp-<n>, in
      // page order); every digit needs its box.
      const boxes = await page.locator('input[name^="pin-"], input[name^="otp-"]').filter({ visible: true }).all();
      if (boxes.length === code.length) {
        for (const [index, digit] of [...code].entries()) {
          await humanClickLocator(page, boxes[index]); await humanType(page, digit);
        }
        filled = true;
        console.log(`[linkedin_login] PIN filled into ${boxes.length} split inputs`);
      } else if (boxes.length) {
        return { ok: false, reason: 'pin_inputs_do_not_match_digits', inputs: boxes.length, digits: code.length };
      }
    }
    if (!filled) return { ok: false, reason: 'no_pin_input_found' };
    const submitCandidates = [
      'button[type="submit"]',
      'button[id="email-pin-submit-button"]',
      'button:has-text(/^\\s*(submit|verify|continue|next|done)\\s*$/i)',
    ];
    for (const sel of submitCandidates) {
      const btn = page.locator(sel).filter({ visible: true }).first();
      if (await btn.count() > 0) {
        try { await humanClickLocator(page, btn); } catch { /* form may have already submitted */ }
        console.log(`[linkedin_login] submit clicked via ${sel}`);
        break;
      }
    }
    await pageSettled(page);
    return { ok: true, code };
  } catch (e) { return { ok: false, reason: `fill_err:${e.message}` }; }
}

export async function solveLinkedinCheckpoint({ ctx, page }, reason, email) {
  let cookies = await ctx.cookies();
  let liAt = cookies.find((c) => c.name === 'li_at' && c.value);
  let finalUrl = page.url?.() ?? '';
  if (!liAt && email && CHECKPOINT_RE.test(finalUrl)) {
    const r = await solveEmailPinChallenge({ page }, email);
    if (r.ok) {
      try { cookies = await ctx.cookies(); } catch {}
      liAt = cookies.find((c) => c.name === 'li_at' && c.value);
      try { finalUrl = page.url?.() ?? finalUrl; } catch {}
      if (liAt || !CHECKPOINT_RE.test(finalUrl)) return { liAt, finalUrl };
    } else if (r.reason !== 'not_email_pin_challenge') {
      console.log(`[linkedin_login] email-PIN handler did not pass: ${r.reason}`);
    }
  }
  if (process.env.WELES_NOPECHA_EXT === '1' && !liAt && CHECKPOINT_RE.test(finalUrl)) {
    // The extension solves in the page; leaving the checkpoint URL is its answer.
    console.log(`[linkedin_login] ${reason} waiting for NopeCha extension to solve checkpoint in-page`);
    finalUrl = await urlMatching(page, (u) => !CHECKPOINT_RE.test(u));
    cookies = await ctx.cookies();
    liAt = cookies.find((c) => c.name === 'li_at' && c.value);
    console.log(`[linkedin_login] NopeCha solved; URL left checkpoint -> ${finalUrl}`);
    if (liAt) return { liAt, finalUrl };
  }
  // /checkpoint/challenge serves the VISIBLE V2-enterprise image-grid widget,
  // not the invisible token flow. CapSolver's ReCaptchaV2EnterpriseTaskProxyLess
  // returns a g-recaptcha-response token in seconds, but injecting it via
  // outer-page DOM (textarea fill + grecaptcha.getResponse override) does NOT
  // trigger the captcha widget's internal verify-callback: consecutive
  // token-injects all leave the URL on /checkpoint.
  // Skip the token attempts entirely and call the in-page image-grid solver,
  // which clicks tiles inside the bframe via the trusted-event Playwright
  // pipeline; this path has demonstrated 'Frame detached — SOLVED!' success.
  if (!liAt && CHECKPOINT_RE.test(finalUrl)) {
    // One solve: a second grid on the same flagged session only trips the
    // login restriction.
    console.log(`[linkedin_login] ${reason} solving checkpoint (in-page image-grid)`);
    const solved = await solveRecaptchaV2InPage(page);
    await pageSettled(page);
    cookies = await ctx.cookies();
    liAt = cookies.find((c) => c.name === 'li_at' && c.value);
    finalUrl = page.url?.() ?? finalUrl;
    if (!liAt && CHECKPOINT_RE.test(finalUrl)) console.log(`[linkedin_login] linkedin_checkpoint_unsolved: solver=${solved} url=${finalUrl}`);
  }
  return { liAt, finalUrl };
}

// Confirm the new account's email by hitting the signed-link URL LinkedIn
// emailed at register-time. The yellow banner persists on /feed and
// limits the account's surface until this is consumed. Subject pattern:
// "<First>, your pin is <6digits>. Please confirm your email address."
// Body contains a https://www.linkedin.com/comm/psettings/email/confirm?...
// link signed with id+ct+sig+crua. Hitting it on an authed session removes
// the banner.
export async function confirmLinkedinEmail(page, email) {
  if (!receivingConfigured()) { console.log('[linkedin_register] the wisent-integrations inbox route is not configured'); return { ok: false, reason: 'no_inbox_route' }; }
  // One inbox read, newest first; a link that has not arrived yet is
  // reported by name. Any LinkedIn mail to this address carrying the confirm
  // link is this account's, so no age decides which one counts.
  let confirmUrl = null;
  const matches = await listReceivedFrom(20, email, 'linkedin.com');
  // The confirmation mail is the one from LinkedIn that carries the
  // confirmation link, whatever its subject says.
  for (const match of matches) {
    const full = await getReceived(match.id);
    const body = full?.text || full?.html || '';
    const m = body.match(/https:\/\/www\.linkedin\.com\/comm\/psettings\/email\/confirm\?[^\s<>"]+/);
    if (m) { confirmUrl = m[0]; break; }
  }
  if (!confirmUrl) { console.log('[linkedin_register] no email-confirmation link in inbox'); return { ok: false, reason: 'confirm_email_not_received' }; }
  console.log(`[linkedin_register] navigating to email-confirmation URL`);
  try { await page.goto(confirmUrl, { waitUntil: 'domcontentloaded' }); }
  catch (e) { return { ok: false, reason: `goto_err:${e.message}` }; }
  await pageSettled(page);
  const finalUrl = page.url?.() ?? '';
  console.log(`[linkedin_register] post-confirm URL: ${finalUrl}`);
  return { ok: true, finalUrl };
}

// Solve invisible reCAPTCHA Enterprise V3 against the login form's sitekey
// and inject the token. LinkedIn's login fires invisible reCAPTCHA on submit;
// tokens from a flagged session score below 0.9 and trigger /checkpoint.
// CapSolver issues a high-score token (typically 0.9) via its token-mill.
export async function injectV3LoginToken(page) {
  try {
    const token = await new CaptchaSolver().solveRecaptchaV3(RECAPTCHA_SITEKEY, page.url(), 'login');
    if (!token) { console.log('[linkedin_login] reCAPTCHA solver returned no token; submitting anyway'); return; }
    console.log(`[linkedin_login] reCAPTCHA token solved (${token.length}ch), injecting`);
    await page.evaluate((t) => {
      try {
        const ge = window.grecaptcha;
        if (ge && ge.enterprise) {
          ge.enterprise.execute = function () { return Promise.resolve(t); };
          ge.enterprise.getResponse = function () { return t; };
        }
        if (ge) {
          ge.execute = function () { return Promise.resolve(t); };
          ge.getResponse = function () { return t; };
        }
      } catch {}
      document.querySelectorAll('textarea[name="g-recaptcha-response"], textarea[name^="g-recaptcha-response-"]').forEach((el) => { el.value = t; });
    }, token);
  } catch (e) { console.log('[linkedin_login] reCAPTCHA solve err:', e.message); }
}
