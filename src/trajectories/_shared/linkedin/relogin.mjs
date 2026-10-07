// Inline auto-relogin for LinkedIn engagement trajectories.
//
// Reauthentication uses the caller's existing connection so the resulting
// cookies and the following action share one provider session.
//
// This helper performs the form-fill + reCAPTCHA V3 + emailPinChallenge on
// the SAME WSession passed in, so the resulting li_at cookies are minted on
// the proxy session the caller is already using and the engagement that
// follows hits the same exit IP. The caller passes its own WSession s and
// the social_accounts row; the helper navigates s.page to /login, fills
// credentials, solves any captcha/PIN gate, and returns { liAt, finalUrl }.

import { CaptchaSolver } from '../../../../dist/captcha/solver.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { solveLinkedinCheckpoint, injectV3LoginToken } from './checkpoint.mjs';
import { pageSettled, urlMatching } from '../page/settled.mjs';

const RECAPTCHA_SITEKEY = '6LcIy_MqAAAAAMKiupFSbmzW3xjGSlIfRzNWYMjC';
const CHECKPOINT_RE = /\/(checkpoint|uas\/login|login\/recovery)/;

export async function reloginLinkedinInline(s, acct) {
  const email = acct?.metadata?.email ?? acct?.username;
  const password = acct?.metadata?.password;
  if (!email || !password) return { ok: false, reason: 'missing_creds' };
  console.log(
    `[linkedin_relogin] starting inline form-login for ${email} on existing session`,
  );
  // Drop stale cookies before navigating to /login so LinkedIn doesn't
  // bounce us back to /feed via the auth-aware redirect.
  try {
    await s.ctx.clearCookies();
  } catch {}
  try {
    await s.page.goto('https://www.linkedin.com/login', {
      waitUntil: 'domcontentloaded',
    });
  } catch (e) {
    return { ok: false, reason: `goto_err:${e.message}` };
  }
  await pageSettled(s.page);
  let landedUrl = s.page.url?.() ?? '';
  console.log(`[linkedin_relogin] post-goto URL: ${landedUrl}`);
  // Pre-form checkpoint check (rare but possible on flagged sessions)
  if (CHECKPOINT_RE.test(landedUrl)) {
    const r = await solveLinkedinCheckpoint(s, 'relogin-pre-form', email);
    if (r.liAt) return { ok: true, liAt: r.liAt, finalUrl: r.finalUrl };
    landedUrl = s.page.url?.() ?? landedUrl;
    console.log(`[linkedin_relogin] post-checkpoint URL: ${landedUrl}`);
  }
  // If page never reached /login (e.g. redirected to /feed, /home, /onboarding,
  // or somewhere else), force-navigate via document.location since clearCookies
  // alone may not have cleared localStorage-bound auth state.
  if (
    !/\/(login|signin|uas\/login)\b/.test(landedUrl) &&
    !CHECKPOINT_RE.test(landedUrl)
  ) {
    console.log(
      `[linkedin_relogin] not on /login — clearing storage and force-navigating`,
    );
    try {
      await s.page.evaluate(
        `(()=>{try{localStorage.clear();sessionStorage.clear();}catch(e){}})()`,
      );
      await s.page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
      });
      await pageSettled(s.page);
      landedUrl = s.page.url?.() ?? '';
      console.log(`[linkedin_relogin] post-force-goto URL: ${landedUrl}`);
    } catch (e) {
      return { ok: false, reason: `force_goto_err:${e.message}` };
    }
  }
  // Fill the form. Same selectors as linkedin_login.mjs.
  const usernameSel =
    'input#username, input[name="session_key"], input[type="email"][autocomplete*="username"], input[type="email"]';
  const passwordSel =
    'input#password, input[name="session_password"], input[type="password"][autocomplete*="current-password"], input[type="password"]';
  try {
    const userLoc = s.page
      .locator(usernameSel)
      .filter({ visible: true })
      .first();
    await userLoc.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, userLoc);
    await pageSettled(s.page);
    await humanType(s.page, email);
    await pageSettled(s.page);
    const pwLoc = s.page.locator(passwordSel).filter({ visible: true }).first();
    await humanClickLocator(s.page, pwLoc);
    await pageSettled(s.page);
    await humanType(s.page, password);
    await pageSettled(s.page);
  } catch (e) {
    return { ok: false, reason: `fill_err:${e.message}` };
  }
  const submitBtn = s.page
    .getByRole('button', { name: /^\s*sign\s*in\s*$/i })
    .filter({ visible: true })
    .first();
  try {
    await submitBtn.waitFor({ state: 'visible' });
  } catch (e) {
    return { ok: false, reason: `submit_not_visible:${e.message}` };
  }
  await injectV3LoginToken(s.page).catch(() => {});
  try {
    await humanClickLocator(s.page, submitBtn);
  } catch {
    /* form may have already submitted */
  }
  // The form posts and the page navigates away from /login whatever the
  // answer; the page it lands on then settles.
  await urlMatching(
    s.page,
    (u) => !/^https?:\/\/www\.linkedin\.com\/login\/?$/.test(u),
  );
  await pageSettled(s.page);
  let cookies = await s.ctx.cookies();
  let liAt = cookies.find((c) => c.name === 'li_at' && c.value);
  let finalUrl = s.page.url?.() ?? '';
  if (!liAt && CHECKPOINT_RE.test(finalUrl)) {
    const r = await solveLinkedinCheckpoint(s, 'relogin-post-submit', email);
    liAt = r.liAt;
    finalUrl = r.finalUrl;
  }
  if (liAt) {
    console.log(
      `[linkedin_relogin] PASS: li_at minted via inline relogin — ${finalUrl}`,
    );
    return { ok: true, liAt, finalUrl };
  }
  return { ok: false, reason: `no_li_at_after_form:${finalUrl}` };
}
