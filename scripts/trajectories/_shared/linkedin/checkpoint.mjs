import { CaptchaSolver } from '../../../../dist/captcha/solver.js';
import { solveRecaptchaV2 as solveRecaptchaV2InPage } from '../../../../dist/captcha/recaptcha.js';
import { humanIdlePause, humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanType } from '../../../../dist/human/keyboard.js';

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
  const RESEND_KEY = process.env.RESEND_RECEIVING_API_KEY;
  if (!RESEND_KEY) return { ok: false, reason: 'no_resend_api_key' };
  // Only accept emails that arrived AFTER /checkpoint was loaded — earlier
  // PINs from prior login attempts are expired. LinkedIn issues a fresh
  // 6-digit PIN per /checkpoint instance.
  const challengeStart = Date.now();
  let code = null;
  for (let i = 0; i < 18; i++) {
    await humanIdlePause('long');
    const list = await fetch(`https://api.resend.com/emails/receiving?limit=20`, { headers: { Authorization: `Bearer ${RESEND_KEY}` } }).then((r) => r.json()).catch(() => null);
    const matches = (list?.data ?? []).filter((m) => m.to?.[0] === email && /linkedin/i.test(m.from || '') && new Date(m.created_at).getTime() >= challengeStart - 5000);
    matches.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const msg = matches[0];
    if (!msg) continue;
    const subj = msg.subject || '';
    const m = subj.match(/\b(\d{6})\b/);
    if (m) { code = m[1]; console.log(`[linkedin_login] PIN ${code} from subject (sent ${msg.created_at})`); break; }
    const full = await fetch(`https://api.resend.com/emails/receiving/${msg.id}`, { headers: { Authorization: `Bearer ${RESEND_KEY}` } }).then((r) => r.json()).catch(() => null);
    const body = (full?.text || full?.html || '').match(/\b(\d{6})\b/);
    if (body) { code = body[1]; console.log(`[linkedin_login] PIN ${code} from body (sent ${msg.created_at})`); break; }
  }
  if (!code) return { ok: false, reason: 'pin_email_timeout' };
  // Live-discover the visible inputs and buttons so we know exactly what
  // selector LinkedIn shipped this variant of the page with. Logged for
  // diagnosis on first failure.
  const inputInfo = await page.evaluate(`(()=>Array.from(document.querySelectorAll('input')).filter(i=>i.offsetParent!==null).map(i=>({name:i.name,id:i.id,type:i.type,ac:i.getAttribute('autocomplete'),maxLen:i.maxLength,ph:i.placeholder})).slice(0,20))()`).catch(() => []);
  console.log(`[linkedin_login] emailPin inputs: ${JSON.stringify(inputInfo)}`);
  const buttonInfo = await page.evaluate(`(()=>Array.from(document.querySelectorAll('button')).filter(b=>b.offsetParent!==null).map(b=>({type:b.type,txt:(b.innerText||b.textContent||'').trim().slice(0,40),id:b.id,name:b.name})).slice(0,10))()`).catch(() => []);
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
      let split = 0;
      for (let i = 0; i < 6; i++) {
        const cell = page.locator(`input[name="pin-${i + 1}"], input[name="otp-${i + 1}"]`).filter({ visible: true }).first();
        if (await cell.count() === 0) break;
        await humanClickLocator(page, cell); await humanType(page, code[i]);
        split++;
      }
      if (split === 6) { filled = true; console.log('[linkedin_login] PIN filled into 6 split inputs'); }
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
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await humanIdlePause('deliberate').catch(() => {});
    return { ok: true, code };
  } catch (e) { return { ok: false, reason: `fill_err:${e.message?.slice(0, 80)}` }; }
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
    console.log(`[linkedin_login] ${reason} waiting for NopeCha extension to solve checkpoint in-page (90s max)`);
    for (let i = 0; i < 18; i++) {
      await humanIdlePause('long');
      cookies = await ctx.cookies();
      liAt = cookies.find((c) => c.name === 'li_at' && c.value);
      finalUrl = page.url?.() ?? '';
      if (liAt) { console.log(`[linkedin_login] NopeCha solved! li_at present after ${(i + 1) * 5}s`); break; }
      if (!CHECKPOINT_RE.test(finalUrl)) { console.log(`[linkedin_login] NopeCha solved! URL left checkpoint after ${(i + 1) * 5}s -> ${finalUrl}`); break; }
    }
    if (liAt) return { liAt, finalUrl };
  }
  // /checkpoint/challenge serves the VISIBLE V2-enterprise image-grid widget,
  // not the invisible token flow. CapSolver's ReCaptchaV2EnterpriseTaskProxyLess
  // returns a g-recaptcha-response token in seconds, but injecting it via
  // outer-page DOM (textarea fill + grecaptcha.getResponse override) does NOT
  // trigger the captcha widget's internal verify-callback — verified live
  // 2026-05-03: 3 consecutive token-injects all left URL on /checkpoint.
  // Skip the token attempts entirely and call the in-page image-grid solver,
  // which clicks tiles inside the bframe via the trusted-event Playwright
  // pipeline; this path has demonstrated 'Frame detached — SOLVED!' success.
  for (let attempt = 0; attempt < 3 && !liAt && CHECKPOINT_RE.test(finalUrl); attempt++) {
    console.log(`[linkedin_login] ${reason} solve attempt ${attempt + 1}/3 (in-page image-grid)`);
    const solved = await solveRecaptchaV2InPage(page).catch((e) => { console.log(`[linkedin_login] in-page solver err: ${e.message?.slice(0, 80)}`); return false; });
    try { cookies = await ctx.cookies(); } catch {}
    liAt = cookies.find((c) => c.name === 'li_at' && c.value);
    try { finalUrl = page.url?.() ?? finalUrl; } catch {}
    if (liAt || !CHECKPOINT_RE.test(finalUrl)) break;
    if (!solved) {
      // image-grid solver returned without success — wait briefly for
      // any in-flight redirect from a verify that just landed, then check.
      await humanIdlePause('deliberate').catch(() => {});
      try { cookies = await ctx.cookies(); } catch {}
      liAt = cookies.find((c) => c.name === 'li_at' && c.value);
      try { finalUrl = page.url?.() ?? finalUrl; } catch {}
      if (liAt || !CHECKPOINT_RE.test(finalUrl)) break;
      // Reset captcha iframe state for the next attempt — after a failed
      // verify, the reCAPTCHA anchor checkbox enters a non-clickable state
      // that breaks subsequent attempts with locator.click timeout. Reload
      // the page (cookies persist via ctx) to get a fresh captcha.
      if (attempt < 2) {
        console.log(`[linkedin_login] ${reason} reloading page before next attempt to reset stale captcha state`);
        try {
          await page.reload({ waitUntil: 'domcontentloaded' });
        } catch (e) {
          console.log(`[linkedin_login] reload err: ${(e && e.message && e.message.slice(0, 80)) || 'unknown'}`);
        }
        try { finalUrl = page.url?.() ?? finalUrl; } catch {}
      }
    }
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
const CONFIRM_GOTO_MS = 30 * 1000;
export async function confirmLinkedinEmail(page, email) {
  const RESEND_KEY = process.env.RESEND_RECEIVING_API_KEY;
  if (!RESEND_KEY) { console.log('[linkedin_register] no RESEND_RECEIVING_API_KEY — skipping email confirmation'); return { ok: false, reason: 'no_resend_key' }; }
  const start = Date.now() - 10 * 60 * 1000;
  let confirmUrl = null;
  for (let i = 0; i < 18; i++) {
    const list = await fetch(`https://api.resend.com/emails/receiving?limit=20`, { headers: { Authorization: `Bearer ${RESEND_KEY}` } }).then((r) => r.json()).catch(() => null);
    const matches = (list?.data ?? []).filter((m) => m.to?.[0] === email && /confirm your email/i.test(m.subject || '') && new Date(m.created_at).getTime() >= start);
    matches.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    if (matches[0]) {
      const full = await fetch(`https://api.resend.com/emails/receiving/${matches[0].id}`, { headers: { Authorization: `Bearer ${RESEND_KEY}` } }).then((r) => r.json()).catch(() => null);
      const body = full?.text || full?.html || '';
      const m = body.match(/https:\/\/www\.linkedin\.com\/comm\/psettings\/email\/confirm\?[^\s<>"]+/);
      if (m) { confirmUrl = m[0]; break; }
    }
    await humanIdlePause('long');
  }
  if (!confirmUrl) { console.log('[linkedin_register] no email-confirmation link in inbox'); return { ok: false, reason: 'confirm_email_not_received' }; }
  console.log(`[linkedin_register] navigating to email-confirmation URL`);
  try { await page.goto(confirmUrl, { waitUntil: 'domcontentloaded', timeout: CONFIRM_GOTO_MS }); }
  catch (e) { return { ok: false, reason: `goto_err:${e.message?.slice(0, 80)}` }; }
  await humanIdlePause('deliberate');
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
  } catch (e) { console.log('[linkedin_login] reCAPTCHA solve err:', e.message?.slice(0, 200)); }
}
