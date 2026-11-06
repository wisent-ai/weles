// Sign the active LinkedIn account in and keep its session.
//
// The proxy is the account's own, resolved by resolveAccountSession (its
// pinned exit, or a static ISP exit pinned to an account without one), so
// the login leaves from the address the account was registered from; a
// pinned exit LinkedIn serves no form through ends the login, and only a
// run that states its own PROXY_URL is rotated (gotoLoginRotating). The
// account's stored PerimeterX
// storage is restored before the page hydrates. An edge checkpoint before
// the form, or after the submit, goes through the captcha solver; a degraded
// shell with no form is refused. The account signs in with its password, or
// through Google when it has none or LINKEDIN_LOGIN_GOOGLE_SSO=1. The login
// counts once LinkedIn sets its li_at cookie; the session's cookies (with
// the proxy they were minted under) and PerimeterX storage are then kept,
// and an unconfirmed email is confirmed from the inbox. Every outcome is
// kept as the run's verdict through the shared verdict writer (a checkpoint
// marks the account's cookies stale); a failure is thrown.
import {
  getSocialAccount,
  resolveAccountSession,
} from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { statedProxy } from '../_shared/inputs/stated.mjs';
import { persistFreshCookieJar } from '../_shared/auth/cookie-freshness.mjs';
import { keepVerdict } from '../_shared/action/verdict.mjs';
import {
  solveLinkedinCheckpoint,
  confirmLinkedinEmail,
} from '../_shared/linkedin/checkpoint.mjs';
import {
  onCheckpointRoute,
  submitLinkedinPassword,
} from '../_shared/linkedin/sign_in.mjs';
import {
  captureLinkedinPxStorage,
  restoreLinkedinPxStorage,
} from '../_shared/linkedin/signup/px_storage.mjs';
import { gotoLoginRotating } from '../_shared/linkedin/signup/proxy_rotation.mjs';
import { loginWithGoogleSso } from './login/google_sso.mjs';
import {
  currentWelesFingerprintTag,
  failedVerdict,
  reapWelesFingerprintTag,
  unsignedVerdict,
} from './login/outcome.mjs';

const LABEL = 'linkedin_login';
if (
  process.env.WELES_INPUT === 'native' &&
  process.env.LINKEDIN_LOGIN_ALLOW_NATIVE !== '1'
)
  throw new Error(
    'LINKEDIN_NATIVE_INPUT_BLOCKED: native OS input is blocked for linkedin_login; set LINKEDIN_LOGIN_ALLOW_NATIVE=1 only during an observed, isolated run',
  );
const acct = await getSocialAccount('linkedin');
if (!acct)
  throw new Error(
    'LINKEDIN_ACCOUNT_UNAVAILABLE: no active LinkedIn account in Skarbiec',
  );
const login = acct.metadata.email ? acct.metadata.email : acct.username;
const password = acct.metadata.password;
const HEADLESS = ['HEADLESS', 'AB_HEADLESS', 'LINKEDIN_LOGIN_HEADLESS'].some(
  (name) => process.env[name] === '1',
);
const USE_GOOGLE_SSO =
  process.env.LINKEDIN_LOGIN_GOOGLE_SSO === '1' || !password;
// The NopeCha extension stays off: it never auto-solves without a key set in
// its own storage, and loading it hung persistent contexts; the NopeCha API
// path in src/captcha does the solving.
if (process.env.WELES_NOPECHA_EXT === undefined)
  process.env.WELES_NOPECHA_EXT = '0';

const accountSession = await resolveAccountSession(acct);
let { persona } = accountSession;
// The account's pinned proxy, or the proxy the run states when it has none;
// a pinned account is never moved to another exit.
const pinned = accountSession.pinned === true;
let proxyUrl =
  accountSession.proxyUrl ??
  statedProxy('the LinkedIn login, whose account has no proxy pin,');
// The account's own persona; when it has none, the session dresses one in
// the locale of the exit it launches through, and later restarts keep it.
const startSession = (proxy, sessionPersona) =>
  WSession.start({
    label: LABEL,
    proxy,
    persona: sessionPersona,
    headless: HEADLESS,
    pageDiagnostics: false,
  });
let s = await startSession(proxyUrl, persona);
persona = s.personaConfig;

/** Solve the checkpoint the page shows; answers what the solver reached. */
async function solveCheckpoint(stage) {
  const solved = await solveLinkedinCheckpoint(s, stage, login);
  return { liAt: solved.liAt, finalUrl: solved.finalUrl };
}

/** What keeping the signed-in session found, for the verdict. */
async function keepSession(finalUrl) {
  const kept = await persistFreshCookieJar(acct, await s.ctx.cookies(), {
    currentProxyUrl: proxyUrl,
    currentPersona: persona,
    persistProxy: true,
  });
  if (!kept.ok)
    throw new Error(
      `LINKEDIN_SESSION_NOT_KEPT: ${kept.reason}${kept.body ? ` (${kept.body})` : ''}`,
    );
  const px = await captureLinkedinPxStorage(s, acct);
  // An unconfirmed email keeps LinkedIn's banner on the feed; the
  // confirmation reads the link LinkedIn mailed, and its answer is recorded.
  const emailConfirmation = await confirmLinkedinEmail(s.page, login);
  return {
    signal: 'healthy',
    healthy: true,
    details: {
      final_url: finalUrl,
      px_storage: px,
      email_confirmation: emailConfirmation,
    },
  };
}

let verdict;
let failure;
try {
  const rotated = await gotoLoginRotating({
    session: s,
    persona,
    pinned,
    restartFn: startSession,
  });
  s = rotated.session;
  if (rotated.proxyUrl) proxyUrl = rotated.proxyUrl;
  const restored = await restoreLinkedinPxStorage(s, acct);
  console.log(`[linkedin_login] px storage: ${JSON.stringify(restored)}`);
  await pageSettled(s.page);
  let liAt;
  let finalUrl = s.page.url();
  if (onCheckpointRoute(finalUrl)) {
    // An edge checkpoint before the form renders.
    ({ liAt, finalUrl } = await solveCheckpoint('pre-form'));
    if (!liAt)
      throw new Error(
        `pre-form captcha solver did not sign in; it ended at ${finalUrl}`,
      );
  } else {
    if (!(await s.page.locator('input').count()))
      throw new Error(
        `degraded_login_shell: no inputs after hydration; body=${JSON.stringify(await s.page.locator('body').innerText())}`,
      );
    if (USE_GOOGLE_SSO) await loginWithGoogleSso(s, acct);
    else await submitLinkedinPassword(s, login, password);
    finalUrl = s.page.url();
    liAt = (await s.ctx.cookies()).find((c) => c.name === 'li_at' && c.value);
    if (!liAt && onCheckpointRoute(finalUrl))
      ({ liAt, finalUrl } = await solveCheckpoint('post-submit'));
  }
  verdict = liAt ? await keepSession(finalUrl) : unsignedVerdict(finalUrl);
  if (!verdict.healthy)
    failure = new Error(
      `LINKEDIN_LOGIN_FAILED: ${verdict.signal} at ${finalUrl}: ${verdict.details.reason}`,
    );
  else console.log(`PASS: li_at cookie set at ${finalUrl}`);
} catch (error) {
  failure = error;
  verdict = failedVerdict(error.message, s.page.url());
  console.log('FAIL:', error.message);
} finally {
  const tag = currentWelesFingerprintTag(s);
  await s.close();
  reapWelesFingerprintTag(tag);
}
try {
  await keepVerdict(LABEL, acct, verdict);
} catch (keepError) {
  failure = failure
    ? new AggregateError(
        [failure, keepError],
        `${failure.message}; and its verdict was not kept: ${keepError.message}`,
      )
    : keepError;
}
if (failure) throw failure;
