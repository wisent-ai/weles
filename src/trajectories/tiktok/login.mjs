import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { persistFreshCookieJar } from '../_shared/auth/cookie-freshness.mjs';
import { screenshotIfPossible } from '../_shared/runner/evidence.mjs';
import { solveTiktokRotateCaptcha } from './login/rotate_captcha.mjs';
import { seedRegionCookies, mockRegionEndpoint } from './login/region.mjs';
import { completeNewDeviceVerification, verifyDialogPresent } from './login/new_device_verify.mjs';
import { waitForSignedIn } from './login/session_wait.mjs';
import { recordLoginFailure } from './login/failure_signal.mjs';

const PASSWORD_URL = 'https://www.tiktok.com/login/phone-or-email/email?lang=en';
const CAPTCHA_MODAL = '.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]';
const SUBMIT = 'button[data-e2e="login-button"], button[type="submit"]';

// There is deliberately no cookie-first login here — see auth-probe.mjs for
// the full rationale. Short version: cookies present + URL didn't bounce ≠
// session is authed. TikTok serves /foryou and /messages with logged-out
// shells when the session is device-mismatched, so cookie-first declared PASS
// while the comment input never rendered for the supposedly-logged-in user.
// Login always means form login. Action trajectories use assertAuthed() from
// auth-probe.mjs to verify a session is real.

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account in DB'); process.exitCode = 1; }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_login', proxy: proxyUrl, persona });
const loginDiag = {
  account_id: acct.id,
  username: acct.username,
  accountApiError: '',
  loginResponses: [],
  failedRequests: [],
  captcha: { present: false, solved: false },
  finalState: null,
};

async function captureCookies() {
  if (!acct.id) return;
  try {
    const cookies = await s.ctx.cookies();
    await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
  } catch (e) { console.log('[cookie-capture] err:', e.message); }
}

/** Record the passport login XHRs, failed requests and page errors into loginDiag. */
function observeLoginTraffic(page) {
  page.on('response', (res) => {
    const u = res.url();
    if (/\/passport\/web\/login|\/passport\/web\/login_with_email|\/passport\/web\/account_check/.test(u)) {
      loginDiag.loginResponses.push({ url: u, status: res.status(), ts: Date.now() });
    }
  });
  page.on('requestfailed', (req) => {
    const u = req.url();
    const f = req.failure?.();
    if (/passport|tiktok|webmssdk|secsdk|verification|captcha/i.test(u)) {
      const headers = req.headers ? req.headers() : {};
      loginDiag.failedRequests.push({
        url: u.slice(0, 200),
        failure: f?.errorText,
        method: req.method(),
        origin: headers.origin || headers.referer?.slice(0, 80),
      });
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const text = msg.text();
      if (/Maximum number of attempts reached|account-api error/i.test(text)) {
        loginDiag.accountApiError = text.slice(0, 200);
      }
      console.log(`[tiktok_login] page-${msg.type()}: ${text.slice(0, 200)}`);
    }
  });
}

/** Fill the email/password form. Its selectors are stable on TikTok's login page. */
async function fillLoginForm(page) {
  await s.goto(PASSWORD_URL);
  const emailIn = page.locator('input[name="username"], input[type="text"][placeholder*="email" i], input[type="email"]').filter({ visible: true }).first();
  const pwIn = page.locator('input[type="password"]').filter({ visible: true }).first();
  await emailIn.waitFor({ state: 'visible' });
  await humanClickLocator(page, emailIn);
  await humanIdlePause('short');
  await humanType(page, process.env.SVC_EMAIL);
  await humanIdlePause('short');
  await humanClickLocator(page, pwIn);
  await humanIdlePause('short');
  await humanType(page, process.env.SVC_PASSWORD);
  await humanIdlePause('short');
  // Diagnostic: snapshot field values + button enabled state right before
  // the click. If button is still disabled, typing didn't fully register.
  const formState = await page.evaluate(() => {
    const u = document.querySelector('input[name="username"]');
    const p = document.querySelector('input[type="password"]');
    const b = document.querySelector('button[data-e2e="login-button"]');
    return {
      usernameLen: u?.value?.length ?? -1,
      passwordLen: p?.value?.length ?? -1,
      buttonDisabled: b?.disabled,
      buttonAria: b?.getAttribute('aria-disabled'),
    };
  }).catch((e) => ({ err: e.message }));
  console.log(`[tiktok_login] form-state pre-submit: ${JSON.stringify(formState)}`);
  await screenshotIfPossible(s, 'pre_submit');
}

/** Solve the rotate captcha, refreshing the puzzle between attempts, then re-submit. */
async function passCaptcha(page) {
  console.log('[tiktok_login] captcha modal detected — attempting SadCaptcha solve');
  let solved = false;
  // retry-allowed: each attempt is a different rotate puzzle after the widget's
  // own refresh control, which is how a person clears one they cannot solve.
  for (let attempt = 0; attempt < 4 && !solved; attempt++) {
    if (attempt > 0) {
      // Click captcha refresh button to get a new puzzle. The icon is a
      // circular arrow at the bottom-right of the modal footer.
      const refresh = page.locator(CAPTCHA_MODAL).locator('button, [role="button"], [class*="refresh" i], [class*="reload" i]').filter({ visible: true }).first();
      const refreshed = await refresh.count() > 0;
      if (refreshed) await humanClickLocator(page, refresh);
      console.log(`[tiktok_login] captcha retry ${attempt} refresh-clicked=${refreshed}`);
      await humanIdlePause('short');
    }
    solved = await solveTiktokRotateCaptcha(page);
    console.log(`[tiktok_login] captcha attempt ${attempt + 1} solved=${solved}`);
  }
  loginDiag.captcha.solved = solved;
  if (!solved) {
    await screenshotIfPossible(s, 'captcha_solve_failed');
    throw new Error('captcha_challenge: SadCaptcha solve failed after 4 attempts');
  }
  // After captcha dismiss, TikTok web does NOT auto-submit the login form
  // (2026-05-02 verified: angle=318 solved captcha but loginResponses=[]).
  // Re-click submit manually to fire /passport/web/login/.
  await humanIdlePause('short');
  const reSubmit = page.locator(SUBMIT).filter({ visible: true }).first();
  if (await reSubmit.count().catch(() => false)) {
    try { await humanClickLocator(page, reSubmit); console.log('[tiktok_login] post-captcha re-submit clicked'); } catch (e) { console.log(`[tiktok_login] re-submit click err: ${e.message?.slice(0,80)}`); }
  }
  await humanIdlePause('deliberate');
  console.log(`[tiktok_login] post-captcha loginResponses=${JSON.stringify(loginDiag.loginResponses)}`);
  if (loginDiag.accountApiError) throw new Error(`login_rate_limited: ${loginDiag.accountApiError}`);
}

try {
  await seedRegionCookies(s.ctx);
  await fillLoginForm(s.page);
  observeLoginTraffic(s.page);
  await mockRegionEndpoint(s.page);
  const submitBtn = s.page.locator(SUBMIT).filter({ visible: true }).first();
  await humanClickLocator(s.page, submitBtn);
  console.log(`[tiktok_login] submit clicked, waiting for sessionid (${loginDiag.loginResponses.length} login XHR captured so far)`);
  await humanIdlePause('deliberate');
  await screenshotIfPossible(s, 'post_submit_3s');
  console.log(`[tiktok_login] +3s loginResponses=${JSON.stringify(loginDiag.loginResponses)}`);
  console.log(`[tiktok_login] +3s failedRequests=${JSON.stringify(loginDiag.failedRequests.slice(0, 10))}`);
  // Captcha modal check. Excludes the "Verify it's really you" dialog which
  // shares the captcha-* class prefix but is an OTP flow handled below.
  const verifyDialogText = await verifyDialogPresent(s.page);
  const captchaPresent = !verifyDialogText && await s.page.evaluate((modal) => !!document.querySelector(modal), CAPTCHA_MODAL).catch(() => false);
  loginDiag.captcha.present = captchaPresent;
  if (captchaPresent) await passCaptcha(s.page);
  // After the captcha, TikTok may ask a new device to prove the email. When
  // the dialog is absent this is a no-op.
  if (await verifyDialogPresent(s.page)) await completeNewDeviceVerification(s, acct);
  await waitForSignedIn(s, loginDiag);
  console.log('PASS: logged in (deterministic email/password)');
  await captureCookies();
} catch (e) {
  try {
    recordLoginFailure(e, s, acct, loginDiag);
  } catch (recordError) {
    console.log(`[tiktok_login] could not record the failure: ${recordError.message}`);
  }
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  await s.close();
}
