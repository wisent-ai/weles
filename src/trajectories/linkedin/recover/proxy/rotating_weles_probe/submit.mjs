// Submitting one signup candidate through the probe's session, when the operator asked for it.
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { getLinkedinChallengeSignal } from '../../../../_shared/linkedin/signup/register_guard.mjs';
import { hash } from './proxies.mjs';
import { classifySummary, linkedinAuthState, summarizeApiResponse, summarizeSignup } from './page.mjs';

export async function submitSignupCandidate(session) {
  const id = session.identity;
  if (!id?.email || !id?.password) throw new Error('missing generated identity');
  const out = {
    attempted: true,
    identity_hashes: {
      email: hash(id.email),
      username: hash(id.username),
      full_name: hash(`${id.firstName} ${id.lastName}`),
    },
    submit1: null,
    create_account: null,
    challenge: null,
    auth: null,
    result: 'unknown',
  };

  const emailLoc = session.page.locator('input[name="email-address"], input#email-address, input[type="email"]').filter({ visible: true }).first();
  const pwdLoc = session.page.locator('input[name="password"], input#password, input[type="password"]').filter({ visible: true }).first();
  await emailLoc.waitFor({ state: 'visible', timeout: 8000 });
  await pwdLoc.waitFor({ state: 'visible', timeout: 8000 });
  await humanFill(session.page, emailLoc, id.email);
  await humanIdlePause('short');
  await humanFill(session.page, pwdLoc, id.password);
  await humanIdlePause('deliberate');

  const submit1Req = session.page.waitForRequest((r) => /\/signup\/api\//.test(r.url()), { timeout: 12_000 }).catch(() => null);
  const submit1Res = session.page.waitForResponse((r) => /\/signup\/api\//.test(r.url()), { timeout: 12_000 }).catch(() => null);
  await humanClickLocator(session.page, session.page.locator('button[type="submit"]:has-text("Agree"), button[type="submit"]:has-text("Continue"), button#join-form-submit').first());
  await humanIdlePause('deliberate');
  const [s1Req, s1Res] = await Promise.all([submit1Req, submit1Res]);
  out.submit1 = {
    request_url: s1Req?.url?.() ?? '',
    response: await summarizeApiResponse(s1Res),
    summary: await summarizeSignup(session.page).catch(() => null),
  };
  const afterSubmit1 = out.submit1.summary ? classifySummary(out.submit1.summary) : { result: 'unknown', signal: '' };
  if (afterSubmit1.signal) {
    out.result = 'challenge_after_email_password';
    return out;
  }

  const firstLoc = session.page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
  const lastLoc = session.page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
  const firstVisible = await firstLoc.isVisible({ timeout: 12_000 }).catch(() => false);
  const lastVisible = await lastLoc.isVisible({ timeout: 3000 }).catch(() => false);
  if (!firstVisible || !lastVisible) {
    out.result = 'no_first_last_after_email_password';
    out.auth = await linkedinAuthState(session);
    return out;
  }

  await humanFill(session.page, firstLoc, id.firstName);
  await humanIdlePause('short');
  await humanFill(session.page, lastLoc, id.lastName);
  await humanIdlePause('deliberate');

  const createReq = session.page.waitForRequest((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  const createRes = session.page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await humanClickLocator(session.page, session.page.locator('button[type="submit"]:has-text("Continue"), button#join-form-submit').first());
  const [cReq, cRes] = await Promise.all([createReq, createRes]);
  const createSummary = await summarizeApiResponse(cRes);
  out.create_account = {
    request_url: cReq?.url?.() ?? '',
    response: createSummary,
  };

  if (createSummary?.has_challenge_url) {
    const challengeUrl = new URL(createSummary.challenge_url_prefix, 'https://www.linkedin.com/').toString();
    await session.page.goto(challengeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await humanIdlePause('deliberate');
    const challengeSummary = await summarizeSignup(session.page).catch(() => null);
    out.challenge = {
      url: session.page.url(),
      summary: challengeSummary,
      signal: challengeSummary ? getLinkedinChallengeSignal(challengeSummary) : '',
    };
    out.result = out.challenge.signal || 'create_account_challenge';
    out.auth = await linkedinAuthState(session);
    return out;
  }

  await humanIdlePause('long');
  out.auth = await linkedinAuthState(session);
  if (out.auth.has_li_at) {
    out.result = 'accepted_authenticated';
    await session.saveAccount('linkedin', {
      username: id.username,
      email: id.email,
      password: id.password,
      name: `${id.firstName} ${id.lastName}`,
      status: 'created_by_rotating_weles_probe',
    }).catch((e) => {
      out.save_error = String(e?.message ?? e).slice(0, 200);
    });
  } else if (/verify|email-verification|checkpoint/.test(out.auth.final_url)) {
    out.result = 'verification_or_checkpoint';
  } else {
    out.result = 'create_account_no_auth';
  }
  return out;
}
