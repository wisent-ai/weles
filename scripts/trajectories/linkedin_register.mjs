/**
 * LinkedIn signup on dedicated ISP proxies.
 *
 * This trajectory does not attempt to solve or bypass CAPTCHA/checkpoint
 * challenges. It records those states as detection failures so operators do
 * not get false PASS signals from blocked registrations.
 */
import { WSession } from '../../dist/session/wsession.js';
import { humanFill, humanType } from '../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { confirmLinkedinEmail } from './_shared/linkedin/checkpoint.mjs';
import { assertLinkedinAuthenticatedRegistration, assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, assertLinkedinRegisterProxyRequest, assertNoLinkedinChallengePage, classifyLinkedinRegisterFailure, ensureLinkedinSignupForm, getLinkedinFailureDiagnostics, linkedinRegisterExitCode } from './_shared/linkedin/register_guard.mjs';
import { fillPostRegisterOnboarding } from './_shared/linkedin/onboarding/work_school.mjs';
// generateIdentity import removed — identity now created by WSession.start via opts.platform.

const URL = 'https://www.linkedin.com/signup';

import { autoBindCharacter } from './lib/character-bind.mjs';

async function saveVerifiedLinkedinAccount(session, account) {
  const result = await session.saveAccount('linkedin', account);
  if (!String(result).startsWith('account saved:')) {
    throw new Error(`ACCOUNT_PERSIST_FAILED: ${String(result).slice(0, 180)}`);
  }
  return result;
}

// Persona + identity + browser + OS + input rotation all centralized in
// WSession.start (platform: 'linkedin'). No browser/OS/input pin — rolls
// naturally like the keeper does.
const requestedProxy = process.env.LINKEDIN_REGISTER_PROXY ?? process.env.LINKEDIN_PROXY ?? process.env.PROXY_URL ?? 'isp decodo us';
console.log(`[register] proxy request: ${requestedProxy.startsWith('http') ? '[url-form]' : requestedProxy}`);
let s = null;
let id = { first: '', last: '', handle: '', email: '', password: '' };
let expectedExitIp = '';
let authState = null;

try {
  assertLinkedinRegisterProxyRequest(requestedProxy);
  s = await WSession.start({ label: 'linkedin_register', proxy: requestedProxy, targetHost: 'www.linkedin.com', platform: 'linkedin' });
  id = { first: s.identity.firstName, last: s.identity.lastName, handle: s.identity.username, email: s.identity.email, password: s.identity.password };
  expectedExitIp = s.proxyConfig?.exit_ip ?? '';
  console.log(`[register] identity: ${id.email} / ${id.first} ${id.last}`);
  // Persist credentials so a captcha failure mid-run still leaves a way to log in via keeper.
  try { const { writeFileSync: _wf } = await import('node:fs'); _wf('/tmp/linkedin_register_creds.txt', `email=${id.email}\nhandle=${id.handle}\npassword=${id.password}\nfirst=${id.first}\nlast=${id.last}\nproxy=${requestedProxy}\nts=${new Date().toISOString()}\n`); }
  catch (e) { console.log(`[register] creds file err: ${e.message?.slice(0, 80)}`); }
  assertLinkedinDedicatedIspProxy(s, requestedProxy);
  await s.goto(URL);
  await humanIdlePause('deliberate');
  expectedExitIp = await assertLinkedinProxyStable(s, 'after_goto', expectedExitIp);
  await assertNoLinkedinChallengePage(s, 'after_goto');
  const { emailLoc, pwdLoc } = await ensureLinkedinSignupForm(s);
  await s.page.evaluate(() => { for (const el of document.querySelectorAll('input,textarea')) { el.setAttribute('autocomplete','off'); el.value=''; } }).catch(e => console.log(`[register] autofill-disable err: ${e.message?.slice(0, 80)}`));
  await humanFill(s.page, emailLoc, id.email);
  await humanFill(s.page, pwdLoc, id.password);
  console.log(`[register] fill email+pwd: ok`);
  expectedExitIp = await assertLinkedinProxyStable(s, 'before_submit_email_password', expectedExitIp);

  const submit1 = await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Agree"), button[type="submit"]:has-text("Continue"), button#join-form-submit, button[data-tracking-control-name*="signup"]').first()).then(() => true).catch(e => { console.log(`[register] submit1 err: ${e.message?.slice(0, 80)}`); return false; });
  console.log(`[register] click Agree & Join: ${submit1}`);
  if (!submit1) throw new Error('Agree & Join button not clickable');
  await humanIdlePause('deliberate');
  await assertNoLinkedinChallengePage(s, 'after_submit_email_password');

  const hasV2 = await s.page.evaluate(() => !!document.querySelector('iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"], div.g-recaptcha[data-sitekey]') || Array.from(document.querySelectorAll('iframe')).some(f => /challengeIframe/.test(f.src ?? '')));
  if (hasV2) throw new Error('DETECTION_TRIGGERED: visible CAPTCHA challenge after email/password submit');

  const firstLoc = s.page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
  const lastLoc = s.page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
  const hasFirst = await firstLoc.count();
  const hasLast = await lastLoc.count();
  let fillBOk = false;
  if (hasFirst && hasLast) {
    await humanFill(s.page, firstLoc, id.first);
    await humanFill(s.page, lastLoc, id.last);
    fillBOk = true;
  } else {
    console.log(`[register] fill first+last skipped (hasFirst=${hasFirst} hasLast=${hasLast} url=${s.page.url()})`);
  }
  if (fillBOk) {
    expectedExitIp = await assertLinkedinProxyStable(s, 'before_create_account', expectedExitIp);
    // Capture /signup/api/cors/createAccount response BEFORE click. On a
    // challenged session LinkedIn returns HTTP 200 with body
    // {submissionId, challengeUrl:"/checkpoint/challengeIframe/..."} — the
    // challenge lives inside an iframe at challengeUrl, NOT a top-level
    // redirect. Without explicitly navigating to challengeUrl the page stays
    // at /signup forever and the post-redirect loop times out as "rejected".
    // Diff harness 2026-05-06 .work/inst/linkedin_register_2026-05-06T17-59-19-014Z.json
    // captured this exact response shape on the 17:59 run.
    const createAccountRes = s.page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url())).catch(() => null);
    const submit2 = await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Continue"), button#join-form-submit').first()).then(() => true).catch(e => { console.log(`[register] submit2 err: ${e.message?.slice(0, 80)}`); return false; });
    console.log(`[register] click Continue: ${submit2}`);
    if (!submit2) throw new Error('Continue button not clickable');
    const apiRes = await createAccountRes;
    let challengeUrl = '';
    if (apiRes) {
      try {
        const body = await apiRes.json();
        challengeUrl = body?.challengeUrl ?? '';
        console.log(`[register] createAccount status=${apiRes.status()} submissionId=${(body?.submissionId ?? '').slice(0, 12)} challengeUrl=${challengeUrl ? challengeUrl.slice(0, 60) + '...' : 'none'}`);
      } catch (e) { console.log(`[register] createAccount body parse err: ${e.message?.slice(0, 80)}`); }
    }
    if (challengeUrl) {
      throw new Error(`DETECTION_TRIGGERED: createAccount challengeUrl=${challengeUrl.slice(0, 120)}`);
    }
    await humanIdlePause('long');
    await assertNoLinkedinChallengePage(s, 'after_create_account');
  }

  // Wait for the post-signup redirect to /feed, /onboarding, or /checkpoint.
  // /signup/api/cors/createAccount issues li_at via Set-Cookie on the next
  // navigation; the redirect can take up to ~30s on the first signup. Check
  // for li_at in the cookie jar directly — once it appears, the account is
  // authenticated even if the URL hasn't fully resolved yet.
  for (let i = 0; i < 30; i++) {
    const u = s.page.url();
    const ck = await s.ctx.cookies().catch(() => []);
    const haveLiAt = ck.some(c => c.name === 'li_at' && c.value);
    if (haveLiAt || /\/feed|\/onboarding|\/check|\/m\/welcome/.test(u)) break;
    if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(u)) break; // signup rejected, no point waiting
    await humanIdlePause('deliberate');
  }
  const verifyUrl = s.page.url();
  console.log(`[register] post-name URL: ${verifyUrl}`);
  process.env.LINKEDIN_NEW_EMAIL = id.email;
  process.env.LINKEDIN_NEW_PASSWORD = id.password;
  process.env.LINKEDIN_NEW_FIRSTNAME = id.first;
  process.env.LINKEDIN_NEW_LASTNAME = id.last;
  process.env.LINKEDIN_NEW_USERNAME = id.handle;
  // Reject /signup as success — silent reCAPTCHA-score rejection looks identical.
  expectedExitIp = await assertLinkedinProxyStable(s, 'before_success_validation', expectedExitIp);
  if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(verifyUrl) || verifyUrl.includes('/signup/api/')) {
    throw new Error(`signup_did_not_complete: URL stayed at ${verifyUrl} — LinkedIn did not accept the registration`);
  }
  if (/verify|email-verification|email_verification|checkpoint/.test(verifyUrl)) {
    // Email verification: poll Resend for 6-digit code → fill PIN input → submit.
    const code = await s.checkEmail(id.email, 'linkedin');
    if (!code || /^no code|^error:/.test(code)) throw new Error(`linkedin verification email did not arrive: ${code}`);
    const pinIn = s.page.locator('input[name="pin"], input[autocomplete="one-time-code"], input#input__email_verification_pin').filter({ visible: true }).first();
    await pinIn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, pinIn);
    await humanType(s.page, code);
    await humanClickLocator(s.page, s.page.locator('button[type="submit"]:has-text("Submit"), button:has-text("Verify"), button[type="submit"]:has-text("Agree"), button#email-pin-submit-button').first());
    await s.page.waitForFunction(() => !/verify|email-verification|email_verification|checkpoint/.test(location.href), { timeout: 30000 }).catch(() => {});
    authState = await assertLinkedinAuthenticatedRegistration(s, 'after_email_verification');
  } else {
    authState = await assertLinkedinAuthenticatedRegistration(s, 'after_registration_redirect');
  }
  // Fill "add a role/school" onboarding gate so stooge can view other profiles.
  try { const ob = await fillPostRegisterOnboarding(s.page); console.log(`[register] onboarding: ${JSON.stringify(ob)}`); } catch (obErr) { console.log(`[register] onboarding err: ${obErr.message?.slice(0, 100)}`); }
  await assertNoLinkedinChallengePage(s, 'after_onboarding');
  authState = await assertLinkedinAuthenticatedRegistration(s, 'after_onboarding');
  expectedExitIp = await assertLinkedinProxyStable(s, 'before_account_persist', expectedExitIp);
  await saveVerifiedLinkedinAccount(s, { username: id.handle, email: id.email, password: id.password, name: `${id.first} ${id.last}` });
  await confirmLinkedinEmail(s.page, id.email).catch((e) => console.log(`[linkedin_register] email confirm err: ${e.message?.slice(0, 80)}`));
  await autoBindCharacter(id.handle, 'linkedin').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
  console.log(`PASS: ${id.handle}`);
  const diagnostics = await getLinkedinFailureDiagnostics(s, requestedProxy, expectedExitIp);
  try { mkdirSync(join(process.cwd(), 'recordings', 'linkedin_register'), { recursive: true }); writeFileSync(join(process.cwd(), 'recordings', 'linkedin_register', 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: 'healthy', healthy: true, details: { username: id.handle, email: id.email, final_url: s.page.url(), auth: authState, diagnostics }, ts: new Date().toISOString() }, null, 2)); } catch {}
} catch (e) {
  const finalUrl = s?.page?.url?.() ?? '';
  const sig = classifyLinkedinRegisterFailure(e.message ?? '', finalUrl);
  const diagnostics = s ? await getLinkedinFailureDiagnostics(s, requestedProxy, expectedExitIp).catch(() => null) : { proxy: { requested: requestedProxy.startsWith('http') ? '[url-form]' : requestedProxy.slice(0, 80) } };
  try { mkdirSync(join(process.cwd(), 'recordings', 'linkedin_register'), { recursive: true }); writeFileSync(join(process.cwd(), 'recordings', 'linkedin_register', 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: sig, healthy: false, details: { final_url: finalUrl, error: e.message?.slice(0, 200), attempted_email: id.email, expected_exit_ip: expectedExitIp, diagnostics }, ts: new Date().toISOString() }, null, 2)); } catch {}
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  // exitCode (not exit) so the finally block's await s.close() actually runs.
  // process.exit(1) kills pending async ops immediately, which prevents
  // Playwright from flushing the recordVideo .webm to disk.
  process.exitCode = linkedinRegisterExitCode(sig);
} finally {
  await s?.close?.();
}
