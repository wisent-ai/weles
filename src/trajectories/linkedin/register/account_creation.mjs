/**
 * The signup form itself: credentials typed and submitted, the name step, the
 * createAccount call and whatever LinkedIn answers it with, then the wait for an
 * authenticated session, the e-mail code, the onboarding gate, the saved account
 * and the character bind. A challenge here ends the run — it is never solved.
 */
import { humanFill, humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanScroll } from '../../../../dist/human/mouse.js';
import { pageSettled, responseAfterAction } from '../../_shared/page/settled.mjs';
import { assertLinkedinAuthenticatedRegistration, assertLinkedinProxyStable, assertNoLinkedinChallengePage, ensureLinkedinSignupForm } from '../../_shared/linkedin/signup/register_guard.mjs';
import { fillPostRegisterOnboarding } from '../../_shared/linkedin/onboarding/work_school.mjs';
import { confirmLinkedinEmail } from '../../_shared/linkedin/checkpoint.mjs';
import { autoBindCharacter } from '../../lib/character-bind.mjs';
import { collectSubmitState, redactDiagnosticText, summarizeRequest, summarizeResponse, writeSubmitDiagnostics } from './diagnostics.mjs';
import { hasVisibleCaptchaChallenge, inspectCreateAccountChallenge } from './refusal.mjs';

const SIGNUP_API = /\/signup\/api\//;
const CREATE_ACCOUNT_API = /\/signup\/api\/cors\/createAccount/;

async function recordSubmitFailure(label, diagnostics, error) {
  diagnostics.operation_error = {
    code: error?.code ?? null,
    message: redactDiagnosticText(String(error?.message ?? error)),
    request_method: error?.requestMethod ?? null,
    request_url: error?.requestUrl ?? null,
    page_url: error?.pageUrl ?? null,
    status: error?.status ?? null,
    network_error: error?.errorText ?? null,
    cause: error?.cause == null ? null : redactDiagnosticText(String(error.cause?.message ?? error.cause)),
  };
  try {
    await writeSubmitDiagnostics(label, diagnostics);
  } catch (diagnosticError) {
    console.error(`[register] ${label} could not be written:`, diagnosticError);
  }
}

async function submitObserved({ session, recordStage }, { button, pattern, stage, afterStage, label, before }) {
  const diagnostics = { before };
  try {
    await button.waitFor({ state: 'visible' });
    if (!(await button.isEnabled())) {
      throw Object.assign(new Error('LinkedIn signup submit button is disabled'), {
        code: 'LINKEDIN_SIGNUP_SUBMIT_DISABLED', pageUrl: session.page.url(),
      });
    }
    const response = await responseAfterAction(session.page,
      request => request.method() === 'POST' && pattern.test(request.url()),
      async () => {
        await humanClickLocator(session.page, button);
        recordStage(stage, { clicked: true });
      });
    diagnostics.request = summarizeRequest(response.request());
    const responseState = {
      requestMethod: response.request().method(), requestUrl: response.url(),
      status: response.status(), pageUrl: session.page.url(),
    };
    let text;
    try {
      text = await response.text();
    } catch (cause) {
      diagnostics.response = summarizeResponse(response, null, cause);
      throw Object.assign(new Error('LinkedIn signup response body could not be read', { cause }), {
        code: 'LINKEDIN_SIGNUP_RESPONSE_FAILED', ...responseState,
      });
    }
    diagnostics.response = summarizeResponse(response, text);
    if (!response.ok()) {
      throw Object.assign(new Error(`LinkedIn signup returned HTTP ${response.status()}`), {
        code: 'LINKEDIN_SIGNUP_HTTP_ERROR', ...responseState,
      });
    }
    await pageSettled(session.page);
    diagnostics.after = await collectSubmitState(session.page, afterStage);
    return { response, text, diagnostics };
  } catch (error) {
    await recordSubmitFailure(label, diagnostics, error);
    throw error;
  }
}

async function saveVerifiedLinkedinAccount(session, account) {
  const result = await session.saveAccount('linkedin', account);
  if (!String(result).startsWith('account saved:')) {
    throw new Error(`ACCOUNT_PERSIST_FAILED: ${String(result)}`);
  }
  return result;
}

// The PIN form posts and LinkedIn moves the page off the verification step,
// or keeps it there with its own message; the settled page answers which.
async function waitPastEmailVerification(page) {
  await pageSettled(page);
}

async function submitEmailAndPassword({ session, identity, recordStage, proxyWatch }) {
  const { emailLoc, pwdLoc } = await ensureLinkedinSignupForm(session);
  recordStage('signup_form_ready');
  // Simulate a human reading the signup form before interacting.
  await humanScroll(session.page, 400, 2);
  await pageSettled(session.page);
  await humanFill(session.page, emailLoc, identity.email);
  await pageSettled(session.page);
  await humanFill(session.page, pwdLoc, identity.password);
  await pageSettled(session.page);
  recordStage('email_password_filled');
  console.log(`[register] fill email+pwd: ok`);
  proxyWatch.expectedExitIp = await assertLinkedinProxyStable(session, 'before_submit_email_password', proxyWatch.expectedExitIp);
  recordStage('proxy_stable_before_email_password_submit');

  const submit1Before = await collectSubmitState(session.page, 'before_submit_email_password');
  const { diagnostics: submit1Diagnostics } = await submitObserved({ session, recordStage }, {
    button: session.page.locator('button[type="submit"]:has-text("Agree"), button[type="submit"]:has-text("Continue"), button#join-form-submit, button[data-tracking-control-name*="signup"]').first(),
    pattern: SIGNUP_API, stage: 'email_password_submitted',
    afterStage: 'after_submit_email_password', label: 'submit1_diagnostics', before: submit1Before,
  });
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
  await pageSettled(session.page);
  await humanFill(session.page, lastLoc, identity.last);
  await pageSettled(session.page);
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
  const { response, text, diagnostics } = await submitObserved({ session, recordStage }, {
    button: session.page.locator('button[type="submit"]:has-text("Continue"), button#join-form-submit').first(),
    pattern: CREATE_ACCOUNT_API, stage: 'create_account_submitted',
    afterStage: 'after_create_account', label: 'submit2_diagnostics', before: submit2Before,
  });
  const createAccountStatus = response.status();
  let createAccountBody;
  try {
    createAccountBody = JSON.parse(text);
  } catch (cause) {
    const error = Object.assign(new Error('LinkedIn createAccount response is not valid JSON', { cause }), {
      code: 'LINKEDIN_CREATE_ACCOUNT_RESPONSE_INVALID',
      requestMethod: response.request().method(), requestUrl: response.url(),
      status: createAccountStatus, pageUrl: session.page.url(),
    });
    await recordSubmitFailure('submit2_diagnostics', diagnostics, error);
    throw error;
  }
  const challengeUrl = createAccountBody?.challengeUrl ?? '';
  diagnostics.create_account = {
    status: createAccountStatus,
    has_challenge_url: Boolean(challengeUrl),
    challenge_url: challengeUrl,
    body_keys: createAccountBody && typeof createAccountBody === 'object' ? Object.keys(createAccountBody).slice(0, 40) : null,
  };
  await writeSubmitDiagnostics('submit2_diagnostics', diagnostics);
  console.log(`[register] createAccount status=${createAccountStatus} submissionId=${(createAccountBody?.submissionId ?? '').slice(0, 12)} challengeUrl=${challengeUrl || 'none'}`);
  recordStage('create_account_response', { status: createAccountStatus, has_challenge_url: Boolean(challengeUrl) });
  if (challengeUrl) await refuseCreateAccountChallenge({ session, recordStage }, challengeUrl);
  await pageSettled(session.page);
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
      challenge_url: challenge.challenge_url,
    });
  } catch (inspectError) {
    classifyError = String(inspectError?.message ?? inspectError);
    recordStage('create_account_challenge_not_classified', { error: classifyError });
  }
  throw new Error(challengeKind
    ? `DETECTION_TRIGGERED: createAccount challengeUrl detected (kind=${challengeKind})`
    : `DETECTION_TRIGGERED: createAccount challengeUrl detected, and the challenge page itself could not be read: ${classifyError}`);
}

async function settleAuthenticatedSession({ session, identity, recordStage, proxyWatch }) {
  // The createAccount answer was awaited before this step; LinkedIn's
  // redirect after it (to /feed, /onboarding, /checkpoint, or back to /signup
  // on a silent rejection) has happened once the page has settled.
  await pageSettled(session.page);
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
  if (!code || /^no (code|email)|^error:/.test(code)) throw new Error(`linkedin verification email did not arrive: ${code}`);
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
  try { const ob = await fillPostRegisterOnboarding(session.page); console.log(`[register] onboarding: ${JSON.stringify(ob)}`); } catch (obErr) { console.log(`[register] onboarding err: ${obErr.message}`); }
  recordStage('onboarding_attempted');
  await assertNoLinkedinChallengePage(session, 'after_onboarding');
  recordStage('no_challenge_after_onboarding');
  authState = await assertLinkedinAuthenticatedRegistration(session, 'after_onboarding');
  recordStage('after_onboarding_authenticated', { authenticated: authState?.has_li_at ?? false });
  proxyWatch.expectedExitIp = await assertLinkedinProxyStable(session, 'before_account_persist', proxyWatch.expectedExitIp);
  recordStage('proxy_stable_before_account_persist');
  await saveVerifiedLinkedinAccount(session, { username: identity.handle, email: identity.email, password: identity.password, name: `${identity.first} ${identity.last}` });
  recordStage('account_persisted');
  await confirmLinkedinEmail(session.page, identity.email).catch((e) => console.log(`[linkedin_register] email confirm err: ${e.message}`));
  await autoBindCharacter(identity.handle, 'linkedin').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message}`));
  return authState;
}
