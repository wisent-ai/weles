/**
 * The signup form itself: credentials typed and submitted, the name step, the
 * createAccount call and whatever LinkedIn answers it with, then the wait for an
 * authenticated session, the e-mail code, the onboarding gate, the saved account
 * and the character bind. A challenge here ends the run — it is never solved.
 */
import { humanFill, humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause, humanScroll } from '../../../../dist/human/mouse.js';
import { assertLinkedinAuthenticatedRegistration, assertLinkedinProxyStable, assertNoLinkedinChallengePage, ensureLinkedinSignupForm } from '../../_shared/linkedin/signup/register_guard.mjs';
import { fillPostRegisterOnboarding } from '../../_shared/linkedin/onboarding/work_school.mjs';
import { confirmLinkedinEmail } from '../../_shared/linkedin/checkpoint.mjs';
import { autoBindCharacter } from '../../lib/character-bind.mjs';
import { collectSubmitState, summarizeRequest, summarizeResponse, writeSubmitDiagnostics } from './diagnostics.mjs';
import { hasVisibleCaptchaChallenge, inspectCreateAccountChallenge } from './refusal.mjs';

const SIGNUP_API = /\/signup\/api\//;
const CREATE_ACCOUNT_API = /\/signup\/api\/cors\/createAccount/;

// A submit is watched for its API traffic, but the traffic is evidence, not a
// precondition: a submit that produces none is a real outcome of this product
// and is reported as such instead of being read as an empty request.
function watchForApiEvent(waiter, label) {
  return waiter
    .then((event) => ({ observed: true, event }))
    .catch((waitError) => ({
      observed: false,
      event: undefined,
      reason: `${label} was never seen: ${String(waitError?.message ?? waitError).slice(0, 200)}`,
    }));
}

async function saveVerifiedLinkedinAccount(session, account) {
  const result = await session.saveAccount('linkedin', account);
  if (!String(result).startsWith('account saved:')) {
    throw new Error(`ACCOUNT_PERSIST_FAILED: ${String(result).slice(0, 180)}`);
  }
  return result;
}

async function waitPastEmailVerification(page) {
  for (let i = 0; i < 30; i++) {
    if (!/verify|email-verification|email_verification|checkpoint/.test(page.url())) return;
    await humanIdlePause('deliberate');
  }
}

async function submitEmailAndPassword({ session, identity, recordStage, proxyWatch }) {
  const { emailLoc, pwdLoc } = await ensureLinkedinSignupForm(session);
  recordStage('signup_form_ready');
  // Simulate a human reading the signup form before interacting.
  await humanScroll(session.page, 400, 2);
  await humanIdlePause('deliberate');
  await humanFill(session.page, emailLoc, identity.email);
  await humanIdlePause('short');
  await humanFill(session.page, pwdLoc, identity.password);
  await humanIdlePause('deliberate');
  recordStage('email_password_filled');
  console.log(`[register] fill email+pwd: ok`);
  proxyWatch.expectedExitIp = await assertLinkedinProxyStable(session, 'before_submit_email_password', proxyWatch.expectedExitIp);
  recordStage('proxy_stable_before_email_password_submit');

  const submit1Before = await collectSubmitState(session.page, 'before_submit_email_password');
  const submit1ReqWatch = watchForApiEvent(session.page.waitForRequest((r) => SIGNUP_API.test(r.url())), 'the signup API request of the email/password submit');
  const submit1ResWatch = watchForApiEvent(session.page.waitForResponse((r) => SIGNUP_API.test(r.url())), 'the signup API response of the email/password submit');
  const submit1 = await humanClickLocator(session.page, session.page.locator('button[type="submit"]:has-text("Agree"), button[type="submit"]:has-text("Continue"), button#join-form-submit, button[data-tracking-control-name*="signup"]').first()).then(() => true).catch(e => { console.log(`[register] submit1 err: ${e.message?.slice(0, 80)}`); return false; });
  console.log(`[register] click Agree & Join: ${submit1}`);
  if (!submit1) throw new Error('Agree & Join button not clickable');
  recordStage('email_password_submitted', { clicked: submit1 });
  await humanIdlePause('deliberate');
  const [submit1Req, submit1Res] = await Promise.all([submit1ReqWatch, submit1ResWatch]);
  const submit1After = await collectSubmitState(session.page, 'after_submit_email_password');
  const submit1Diagnostics = {
    request: await summarizeRequest(submit1Req.event),
    response: await summarizeResponse(submit1Res.event),
    before: submit1Before,
    after: submit1After,
    request_unseen_reason: submit1Req.observed ? '' : submit1Req.reason,
    response_unseen_reason: submit1Res.observed ? '' : submit1Res.reason,
  };
  await writeSubmitDiagnostics('submit1_diagnostics', submit1Diagnostics);
  console.log(`[register] submit1 api=${submit1Diagnostics.request?.method ?? 'none'} status=${submit1Diagnostics.response?.status ?? 'none'} url=${submit1Diagnostics.response?.url ?? submit1Diagnostics.request?.url ?? 'none'}`);
  await assertNoLinkedinChallengePage(session, 'after_submit_email_password');
  recordStage('no_challenge_after_email_password_submit');

  const hasV2 = await hasVisibleCaptchaChallenge(session.page);
  recordStage('captcha_frame_probe', { has_visible_captcha_frame: hasV2 });
  if (hasV2) throw new Error('DETECTION_TRIGGERED: visible CAPTCHA challenge after email/password submit');
}

async function submitNames({ session, identity, recordStage, proxyWatch }) {
  const firstLoc = session.page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
  const lastLoc = session.page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
  const hasFirst = await firstLoc.count();
  const hasLast = await lastLoc.count();
  if (!(hasFirst && hasLast)) {
    console.log(`[register] fill first+last skipped (hasFirst=${hasFirst} hasLast=${hasLast} url=${session.page.url()})`);
    recordStage('first_last_skipped', { has_first_input: Boolean(hasFirst), has_last_input: Boolean(hasLast) });
    return;
  }
  await humanFill(session.page, firstLoc, identity.first);
  await humanIdlePause('short');
  await humanFill(session.page, lastLoc, identity.last);
  await humanIdlePause('deliberate');
  recordStage('first_last_filled');
  proxyWatch.expectedExitIp = await assertLinkedinProxyStable(session, 'before_create_account', proxyWatch.expectedExitIp);
  recordStage('proxy_stable_before_create_account');
  const submit2Before = await collectSubmitState(session.page, 'before_create_account');
  // Capture /signup/api/cors/createAccount response BEFORE click. On a
  // challenged session LinkedIn returns HTTP 200 with body
  // {submissionId, challengeUrl:"/checkpoint/challengeIframe/..."} — the
  // challenge lives inside an iframe at challengeUrl, NOT a top-level
  // redirect. Without explicitly navigating to challengeUrl the page stays
  // at /signup forever and the post-redirect loop times out as "rejected".
  // Diff harness 2026-05-06 .work/inst/linkedin_register_2026-05-06T17-59-19-014Z.json
  // captured this exact response shape on the 17:59 run.
  const createAccountReq = watchForApiEvent(session.page.waitForRequest((r) => CREATE_ACCOUNT_API.test(r.url())), 'the createAccount request');
  const createAccountRes = watchForApiEvent(session.page.waitForResponse((r) => CREATE_ACCOUNT_API.test(r.url())), 'the createAccount response');
  const submit2 = await humanClickLocator(session.page, session.page.locator('button[type="submit"]:has-text("Continue"), button#join-form-submit').first()).then(() => true).catch(e => { console.log(`[register] submit2 err: ${e.message?.slice(0, 80)}`); return false; });
  console.log(`[register] click Continue: ${submit2}`);
  if (!submit2) throw new Error('Continue button not clickable');
  recordStage('create_account_submitted', { clicked: submit2 });
  const [apiReq, apiRes] = await Promise.all([createAccountReq, createAccountRes]);
  let challengeUrl = '';
  let createAccountStatus = null;
  let createAccountBody = null;
  if (apiRes.observed) {
    try {
      createAccountBody = await apiRes.event.json();
      challengeUrl = createAccountBody?.challengeUrl ?? '';
      createAccountStatus = apiRes.event.status();
      console.log(`[register] createAccount status=${createAccountStatus} submissionId=${(createAccountBody?.submissionId ?? '').slice(0, 12)} challengeUrl=${challengeUrl ? challengeUrl.slice(0, 60) + '...' : 'none'}`);
    } catch (e) { console.log(`[register] createAccount body parse err: ${e.message?.slice(0, 80)}`); }
  }
  const submit2After = await collectSubmitState(session.page, 'after_create_account');
  await writeSubmitDiagnostics('submit2_diagnostics', {
    request: await summarizeRequest(apiReq.event),
    response: await summarizeResponse(apiRes.event),
    before: submit2Before,
    after: submit2After,
    request_unseen_reason: apiReq.observed ? '' : apiReq.reason,
    response_unseen_reason: apiRes.observed ? '' : apiRes.reason,
    create_account: {
      status: createAccountStatus,
      has_challenge_url: Boolean(challengeUrl),
      challenge_url: challengeUrl ? challengeUrl.slice(0, 200) : '',
      body_keys: createAccountBody && typeof createAccountBody === 'object' ? Object.keys(createAccountBody).slice(0, 40) : null,
    },
  });
  recordStage('create_account_response', { status: createAccountStatus, has_challenge_url: Boolean(challengeUrl) });
  if (challengeUrl) await refuseCreateAccountChallenge({ session, recordStage }, challengeUrl);
  await humanIdlePause('long');
  await assertNoLinkedinChallengePage(session, 'after_create_account');
  recordStage('no_challenge_after_create_account');
}

// G19: captcha/challenge means the run is burned. Do not attempt to solve it
// (that hangs indefinitely and kills the close-time diagnostics). Instead
// classify the challenge page, record it, and fail fast so the finally block
// can flush the fingerprint + detection report.
async function refuseCreateAccountChallenge({ session, recordStage }, challengeUrl) {
  let challengeKind = '';
  let classifyError = '';
  try {
    const challenge = await inspectCreateAccountChallenge(session, challengeUrl);
    challengeKind = challenge.kind;
    recordStage('create_account_challenge_classified', {
      challenge_kind: challenge.kind,
      challenge_title: challenge.title || '',
      challenge_url: challenge.challenge_url.slice(0, 200),
    });
  } catch (inspectError) {
    classifyError = String(inspectError?.message ?? inspectError).slice(0, 200);
    recordStage('create_account_challenge_not_classified', { error: classifyError });
  }
  throw new Error(challengeKind
    ? `DETECTION_TRIGGERED: createAccount challengeUrl detected (kind=${challengeKind})`
    : `DETECTION_TRIGGERED: createAccount challengeUrl detected, and the challenge page itself could not be read: ${classifyError}`);
}

async function settleAuthenticatedSession({ session, identity, recordStage, proxyWatch }) {
  // Wait for the post-signup redirect to /feed, /onboarding, or /checkpoint.
  // /signup/api/cors/createAccount issues li_at via Set-Cookie on the next
  // navigation; the redirect can take up to ~30s on the first signup. Check
  // for li_at in the cookie jar directly — once it appears, the account is
  // authenticated even if the URL hasn't fully resolved yet.
  for (let i = 0; i < 30; i++) {
    const u = session.page.url();
    const ck = await session.ctx.cookies();
    const haveLiAt = ck.some(c => c.name === 'li_at' && c.value);
    if (haveLiAt || /\/feed|\/onboarding|\/check|\/m\/welcome/.test(u)) break;
    if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(u)) break; // signup rejected, no point waiting
    await humanIdlePause('deliberate');
  }
  const verifyUrl = session.page.url();
  console.log(`[register] post-name URL: ${verifyUrl}`);
  recordStage('post_name_url', { verify_url: verifyUrl });
  // Reject /signup as success — silent reCAPTCHA-score rejection looks identical.
  proxyWatch.expectedExitIp = await assertLinkedinProxyStable(session, 'before_success_validation', proxyWatch.expectedExitIp);
  recordStage('proxy_stable_before_success_validation');
  if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(verifyUrl) || verifyUrl.includes('/signup/api/')) {
    throw new Error(`signup_did_not_complete: URL stayed at ${verifyUrl} — LinkedIn did not accept the registration`);
  }
  if (!/verify|email-verification|email_verification|checkpoint/.test(verifyUrl)) {
    const redirected = await assertLinkedinAuthenticatedRegistration(session, 'after_registration_redirect');
    recordStage('registration_redirect_authenticated', { authenticated: redirected?.has_li_at ?? false });
    return redirected;
  }
  // Email verification: poll Resend for 6-digit code → fill PIN input → submit.
  const code = await session.checkEmail(identity.email, 'linkedin');
  if (!code || /^no code|^error:/.test(code)) throw new Error(`linkedin verification email did not arrive: ${code}`);
  const pinIn = session.page.locator('input[name="pin"], input[autocomplete="one-time-code"], input#input__email_verification_pin').filter({ visible: true }).first();
  await pinIn.waitFor({ state: 'visible' });
  await humanClickLocator(session.page, pinIn);
  await humanType(session.page, code);
  await humanClickLocator(session.page, session.page.locator('button[type="submit"]:has-text("Submit"), button:has-text("Verify"), button[type="submit"]:has-text("Agree"), button#email-pin-submit-button').first());
  await waitPastEmailVerification(session.page);
  const verified = await assertLinkedinAuthenticatedRegistration(session, 'after_email_verification');
  recordStage('email_verification_completed', { authenticated: verified?.has_li_at ?? false });
  return verified;
}

export async function createLinkedinAccount(ctx) {
  const { session, identity, recordStage, proxyWatch } = ctx;
  await submitEmailAndPassword(ctx);
  await submitNames(ctx);
  let authState = await settleAuthenticatedSession(ctx);
  // Fill "add a role/school" onboarding gate so stooge can view other profiles.
  try { const ob = await fillPostRegisterOnboarding(session.page); console.log(`[register] onboarding: ${JSON.stringify(ob)}`); } catch (obErr) { console.log(`[register] onboarding err: ${obErr.message?.slice(0, 100)}`); }
  recordStage('onboarding_attempted');
  await assertNoLinkedinChallengePage(session, 'after_onboarding');
  recordStage('no_challenge_after_onboarding');
  authState = await assertLinkedinAuthenticatedRegistration(session, 'after_onboarding');
  recordStage('after_onboarding_authenticated', { authenticated: authState?.has_li_at ?? false });
  proxyWatch.expectedExitIp = await assertLinkedinProxyStable(session, 'before_account_persist', proxyWatch.expectedExitIp);
  recordStage('proxy_stable_before_account_persist');
  await saveVerifiedLinkedinAccount(session, { username: identity.handle, email: identity.email, password: identity.password, name: `${identity.first} ${identity.last}` });
  recordStage('account_persisted');
  await confirmLinkedinEmail(session.page, identity.email).catch((e) => console.log(`[linkedin_register] email confirm err: ${e.message?.slice(0, 80)}`));
  await autoBindCharacter(identity.handle, 'linkedin').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
  return authState;
}
