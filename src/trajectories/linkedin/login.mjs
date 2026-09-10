import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { generatePersona } from '../../../dist/browser/persona.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { persistFreshCookieJar } from '../_shared/auth/cookie-freshness.mjs';
import { solveLinkedinCheckpoint, injectV3LoginToken, confirmLinkedinEmail } from '../_shared/linkedin/checkpoint.mjs';
import { captureLinkedinPxStorage, restoreLinkedinPxStorage } from '../_shared/linkedin/signup/px_storage.mjs';
import { gotoLoginRotating } from '../_shared/linkedin/signup/proxy_rotation.mjs';
import { chooseLoginProxy } from './login/proxy_choice.mjs';
import { loginWithGoogleSso } from './login/google_sso.mjs';
import { CHECKPOINT_RE, classifyLoginError, currentWelesFingerprintTag, markStaleAndFail, reapWelesFingerprintTag, writeBan } from './login/outcome.mjs';
import { CONFIRM_EMAIL_WAIT_MS, GOTO_MS } from './login/constants.mjs';

if (process.env.WELES_INPUT === 'native' && process.env.LINKEDIN_LOGIN_ALLOW_NATIVE !== '1') {
  console.error('FAIL: native OS input is blocked for linkedin_login. Set LINKEDIN_LOGIN_ALLOW_NATIVE=1 only during an observed, isolated run.');
  process.exit(2);
}

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account in DB'); process.exitCode = 1; }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
const HEADLESS = process.env.HEADLESS === '1' || process.env.AB_HEADLESS === '1' || process.env.LINKEDIN_LOGIN_HEADLESS === '1';
const USE_GOOGLE_SSO = process.env.LINKEDIN_LOGIN_GOOGLE_SSO === '1' || !process.env.SVC_PASSWORD;
console.log(`[trajectory] Using account: ${acct.username}`);

// 2026-05-03: removed WELES_DISABLE_HTTP2 + WELES_USE_STOCK_CHROMIUM defaults
// (HTTP/1.1 + stock chromium broke the fingerprint stack).
// NopeCha browser extension disabled 2026-05-06: it never auto-solves
// because chrome.storage.local.settings.key is empty (no programmatic
// init). Loading it caused 2/5 launchPersistentContext hangs and the
// trajectory's 90s extension-wait yields nothing. The NopeCha API
// recognition path in src/captcha/recaptcha.ts does the actual solving
// via direct API calls — no extension needed.
if (process.env.WELES_NOPECHA_EXT == null) process.env.WELES_NOPECHA_EXT = '0';

// Sticky proxy URL per call. Prefer Oxylabs — verified 2026-05-02 via curl
// that Oxylabs/PacketStream/direct return HTTP 200 on linkedin.com/login while
// BrightData returns HTTP 000 (LinkedIn edge-blocks brightdata residential
// for this customer's IP range).
// 2026-05-03: removed the unconditional fresh-sticky override. It ALWAYS
// picked a new Oxylabs sticky session, bypassing metadata.proxy, so every
// login hit LinkedIn from a different exit IP than the registration session,
// which LinkedIn's risk model treats as account-takeover-in-progress and
// pushes to /checkpoint regardless of credentials. resolveAccountSession
// (src/account/session.ts) already prefers metadata.proxy when it's not
// burned/legacy/capability-failed; chooseLoginProxy only replaces a stored
// proxy that is not a static ISP host.
let { proxyUrl, persona } = await resolveAccountSession(acct);
// No OS/browser pin — reuse the account's resolved persona; only generate a
// fresh, naturally-rolled one if the account has none.
if (!persona) persona = generatePersona();
proxyUrl = await chooseLoginProxy(proxyUrl, acct.username);
console.log(`[linkedin_login:dbg] before WSession.start`);
let s = await WSession.start({ label: 'linkedin_login', proxy: proxyUrl, persona, headless: HEADLESS, pageDiagnostics: false });
console.log(`[linkedin_login:dbg] after WSession.start, s.page=${s?.page ? 'ok' : 'null'} url=${s?.page?.url?.() ?? 'unknown'}`);

async function gotoLogin() {
  // Rotation-aware. On stripped_login_shell or goto_chrome_error,
  // gotoLoginRotating curl-probes fresh stickies via PROVIDER_ROTATION,
  // tears down the WSession, and restarts with a working proxy. Returns
  // the (possibly fresh) session + the proxyUrl actually in use, which
  // we persist in captureCookies via metadata.proxy.
  const r = await gotoLoginRotating({ session: s, persona, restartFn: async (url, p) => WSession.start({ label: 'linkedin_login', proxy: url, persona: p, headless: HEADLESS, pageDiagnostics: false }), maxRotations: 5, gotoTimeoutMs: GOTO_MS });
  s = r.session;
  if (r.proxyUrl) proxyUrl = r.proxyUrl;
}

async function captureCookies() {
  if (!acct.id) return;
  try {
    const cookies = await s.ctx.cookies();
    await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona, persistProxy: true });
  } catch (e) { console.log('[cookie-capture] err:', e.message); }
}

/** Resolve with the promise's value, or with false once `ms` has passed. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => {
      console.log(`[linkedin_login] ${label} timed out after ${ms}ms`);
      resolve(false);
    }, ms)),
  ]);
}

/** Restore PX storage, then either solve an edge checkpoint or refuse a degraded shell. */
async function prepareLoginPage() {
  // Restore PerimeterX localStorage from prior successful session (if any)
  // BEFORE waiting for the page to hydrate. PX reads __pxvid and px_fp on
  // bootstrap; once the bundle has run those reads, injecting later is a
  // no-op. Page is already on linkedin.com origin after gotoLogin so
  // localStorage writes hit the right origin.
  await restoreLinkedinPxStorage(s, acct).catch((e) => console.log(`[linkedin_login] px storage not restored: ${e.message?.slice(0, 120)}`));
  await humanIdlePause('deliberate');
  // Pre-form-render checkpoint: PerimeterX edge-redirects flagged proxy IPs
  // from /login → /checkpoint/challenge before SDUI form renders. Detect
  // here so the form-fill below doesn't time out 30s on inputs that won't
  // appear.
  const earlyUrl = s.page.url?.() ?? '';
  if (CHECKPOINT_RE.test(earlyUrl)) {
    console.log(`[linkedin_login] pre-form checkpoint at ${earlyUrl} — solving captcha first`);
    const r = await solveLinkedinCheckpoint(s, 'pre-form', acct.metadata?.email ?? acct.username);
    if (!r.liAt) throw new Error(`pre-form captcha solver failed at ${r.finalUrl}`);
    await captureCookies();
    await captureLinkedinPxStorage(s, acct).catch((e) => console.log(`[linkedin_login] px storage not captured: ${e.message?.slice(0, 120)}`));
    writeBan(acct, 'healthy', { final_url: r.finalUrl });
    console.log(`PASS: li_at cookie set via pre-form captcha solve — ${r.finalUrl}`);
    await s.close();
    process.exit(0);
  }
  // Degraded /login skeleton: LinkedIn serves a 13KB SSR shell (no SDUI
  // bootstrap, no inputs) to suspect IPs. Fast-fail on an empty form after
  // hydration so the form-fill below doesn't time out.
  const inputCount = await s.page.evaluate(() => document.querySelectorAll('input').length);
  if (inputCount === 0) {
    const bodyText = await s.page.evaluate(() => (document.body?.innerText ?? '').slice(0, 500));
    throw new Error(`degraded_login_shell: no inputs after hydration window; body=${JSON.stringify(bodyText.slice(0, 200))}`);
  }
}

/** Fill the email/password form and submit it on either LinkedIn login shell. */
async function loginWithPassword() {
  // flagship3 SDUI (current 2026-05): id=":r3:" type="email" autocomplete=
  // "username webauthn". Old shells: id=username, name=session_key.
  // Use locator click+humanType so the React onChange fires.
  const usernameSel = 'input#username, input[name="session_key"], input[type="email"][autocomplete*="username"], input[type="email"]';
  const passwordSel = 'input#password, input[name="session_password"], input[type="password"][autocomplete*="current-password"], input[type="password"]';
  const userLoc = s.page.locator(usernameSel).filter({ visible: true }).first();
  await userLoc.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, userLoc);
  await humanIdlePause('short');
  await humanType(s.page, process.env.SVC_EMAIL ?? '');
  await humanIdlePause('short');
  const pwLoc = s.page.locator(passwordSel).filter({ visible: true }).first();
  await humanClickLocator(s.page, pwLoc);
  await humanIdlePause('short');
  await humanType(s.page, process.env.SVC_PASSWORD ?? '');
  await humanIdlePause('short');
  // LinkedIn serves two login shells:
  //   (A) Legacy checkpoint-frontend: <form> + <button type="submit">,
  //       PerimeterX iframe gates the click handler that POSTs
  //       /checkpoint/pk/initiateLogin then submits to /checkpoint/lg/login-submit.
  //   (B) flagship3 SDUI: <button type="button"> with React onClick that
  //       POSTs /flagship-web/rsc-action/actions/server-request.
  // getByRole('button', name='Sign in') finds the submit on either shell.
  const submitBtn = s.page.getByRole('button', { name: /^\s*sign\s*in\s*$/i }).filter({ visible: true }).first();
  await submitBtn.waitFor({ state: 'visible' });
  await injectV3LoginToken(s.page);
  await humanClickLocator(s.page, submitBtn);
  for (let i = 0; i < 12; i++) {
    await humanIdlePause('short');
    if (!/^https?:\/\/www\.linkedin\.com\/login\/?$/.test(s.page.url())) break;
  }
}

try {
  await gotoLogin();
  await prepareLoginPage();
  if (USE_GOOGLE_SSO) {
    console.log('[linkedin_login] using Google SSO path');
    await loginWithGoogleSso(s, acct);
  } else {
    await loginWithPassword();
  }
  console.log(`[linkedin_login] post-submit url=${s.page.url()}`);

  let cookies = await s.ctx.cookies();
  let liAt = cookies.find((c) => c.name === 'li_at' && c.value);
  let finalUrl = s.page.url?.() ?? '';
  let title = await s.page.title?.().catch((e) => `unreadable: ${e.message}`) ?? '';
  let onCheckpoint = CHECKPOINT_RE.test(finalUrl) || /Security Verification/.test(title);

  // Post-submit checkpoint: route through the V2 enterprise solver. Old
  // path called solvePerimeterX which CapSolver returns ERROR_TYPE_NOT_SUPPORTED
  // for — never produced cookies. V2 enterprise solves the actual reCAPTCHA
  // image-grid LinkedIn shows on /checkpoint/challenge.
  if (!liAt && onCheckpoint) {
    const r = await solveLinkedinCheckpoint(s, 'post-submit', acct.metadata?.email ?? acct.username);
    liAt = r.liAt;
    finalUrl = r.finalUrl;
    onCheckpoint = CHECKPOINT_RE.test(finalUrl);
  }

  if (liAt) {
    await captureCookies();
    await captureLinkedinPxStorage(s, acct).catch((e) => console.log(`[linkedin_login] px storage not captured: ${e.message?.slice(0, 120)}`));
    // Best-effort retroactive email confirmation. Accounts registered before
    // confirmLinkedinEmail was wired into linkedin_register.mjs (a51f39e)
    // still carry the unconfirmed-email yellow banner that suppresses feed
    // posts and triggers captcha_challenge on first write actions. The
    // helper is a no-op when no recent confirm-email is in the inbox.
    await withTimeout(confirmLinkedinEmail(s.page, acct.metadata?.email ?? acct.username).catch((e) => console.log(`[linkedin_login] confirmLinkedinEmail: ${e.message?.slice(0, 120)}`)), CONFIRM_EMAIL_WAIT_MS, 'confirmLinkedinEmail');
    writeBan(acct, 'healthy', { final_url: finalUrl });
    console.log(`PASS: li_at cookie set — ${finalUrl}`);
  } else if (onCheckpoint) {
    await markStaleAndFail(acct, 'linkedin issued V2 enterprise captcha; CapSolver token did not satisfy /checkpoint', finalUrl);
    console.log(`FAIL: linkedin checkpoint — ${finalUrl} (cookies marked stale)`);
    process.exitCode = 1;
  } else if (finalUrl.startsWith('chrome-error://')) {
    writeBan(acct, 'proxy_failed', { final_url: finalUrl, reason: 'chrome-error: proxy CONNECT failed before login completed' });
    console.log(`FAIL: proxy_failed — ${finalUrl}`);
    process.exitCode = 1;
  } else if (/^https:\/\/www\.linkedin\.com\/login(\/|\?|$)/.test(finalUrl)) {
    // Bounce back to /login = credentials rejected or session_redirect loop.
    // Mark stale so routine cron stops re-attempting against a dead account.
    await markStaleAndFail(acct, 'submit returned to /login — credentials rejected or session_redirect loop', finalUrl);
    console.log(`FAIL: linkedin login bounced back — ${finalUrl} (cookies marked stale)`);
    process.exitCode = 1;
  } else {
    await markStaleAndFail(acct, 'no li_at cookie set after submit', finalUrl);
    console.log(`FAIL: no li_at cookie — ${finalUrl} (cookies marked stale)`);
    process.exitCode = 1;
  }
} catch (e) {
  const finalUrl = s.page?.url?.() ?? '';
  const msg = e.message ?? '';
  const sig = classifyLoginError(msg, finalUrl);
  if (sig === 'checkpoint' && acct.id) await markCookiesStale(acct.id);
  writeBan(acct, sig, { final_url: finalUrl, error: msg.slice(0, 200) });
  console.log('FAIL:', msg.slice(0, 200));
  process.exitCode = 1;
} finally {
  const fpTag = currentWelesFingerprintTag(s);
  await s.close();
  reapWelesFingerprintTag(fpTag);
  process.exit(process.exitCode ?? 0);
}
