// The guard around a LinkedIn registration: the signup form is reached, the
// session is authenticated, no challenge page stands in the way, and the run's
// failure is classified for the worker. The page readers live in
// register_guard/page_state.mjs and the proxy assertions in register_guard/proxy.mjs;
// both are re-exported here, the one module every LinkedIn trajectory imports.
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { LINKEDIN_SIGNUP_EMAIL_SELECTOR, LINKEDIN_SIGNUP_PASSWORD_SELECTOR, assertNoLinkedinChallengePage, firstVisible, getLinkedinAuthState, getLinkedinChallengeSignal, summarizeLinkedinPage } from './register_guard/page_state.mjs';
import { assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, assertLinkedinRegisterProxyRequest, getLinkedinFailureDiagnostics, summarizeLinkedinProxyState } from './register_guard/proxy.mjs';

export { LINKEDIN_SIGNUP_EMAIL_SELECTOR, LINKEDIN_SIGNUP_PASSWORD_SELECTOR, assertNoLinkedinChallengePage, getLinkedinAuthState, getLinkedinChallengeSignal };
export { assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, assertLinkedinRegisterProxyRequest, getLinkedinFailureDiagnostics, summarizeLinkedinProxyState };

export async function assertLinkedinAuthenticatedRegistration(session, stage = '') {
  const state = await getLinkedinAuthState(session);
  const challengeSignal = getLinkedinChallengeSignal({ url: state.final_url });
  if (challengeSignal) {
    throw new Error(`DETECTION_TRIGGERED: ${challengeSignal} stage=${stage} final_url=${state.final_url.slice(0, 160)}`);
  }
  if (/^https?:\/\/www\.linkedin\.com\/signup\/?$/.test(state.final_url) || state.final_url.includes('/signup/api/')) {
    throw new Error(`signup_did_not_complete: stage=${stage} final_url=${state.final_url}`);
  }
  if (/verify|email-verification|email_verification|checkpoint/.test(state.final_url)) {
    throw new Error(`signup_verification_incomplete: stage=${stage} final_url=${state.final_url}`);
  }
  if (!state.has_li_at) {
    throw new Error(`signup_did_not_authenticate: stage=${stage} final_url=${state.final_url} linkedin_cookie_count=${state.linkedin_cookie_count}`);
  }
  return state;
}

async function nudgeIntoSignup(page) {
  const joinSelectors = [
    'a[href*="/signup"]:has-text("Join now")',
    'a:has-text("Join now")',
    'button:has-text("Join now")',
    'a[href*="/signup"]',
  ];
  for (const sel of joinSelectors) {
    const loc = await firstVisible(page, sel, 1200);
    if (!loc) continue;
    await humanClickLocator(page, loc).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    return `clicked:${sel}`;
  }
  const url = page.url?.() ?? '';
  if (!/\/signup/.test(url)) {
    await page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
    return 'goto:/signup';
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  return 'reload:/signup';
}

export async function ensureLinkedinSignupForm(session, maxAttempts = 3) {
  const page = session.page;
  const actions = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const emailLoc = await firstVisible(page, LINKEDIN_SIGNUP_EMAIL_SELECTOR, attempt === 0 ? 3500 : 7000);
    const pwdLoc = emailLoc ? await firstVisible(page, LINKEDIN_SIGNUP_PASSWORD_SELECTOR, 1500) : null;
    if (emailLoc && pwdLoc) {
      console.log(`[linkedin_register] signup form ready after ${attempt + 1} attempt(s) actions=${actions.join('|') || 'none'}`);
      return { emailLoc, pwdLoc };
    }
    actions.push(await nudgeIntoSignup(page));
    await humanIdlePause('deliberate').catch(() => {});
  }
  const summary = await summarizeLinkedinPage(page);
  throw new Error(`signup_form_unavailable: ${JSON.stringify(summary).slice(0, 900)}`);
}

export function classifyLinkedinRegisterFailure(errorMessage = '', finalUrl = '') {
  if (/^(PROXY_|PROXY_NOT_DEDICATED_ISP)|proxy_unavailable/i.test(errorMessage) || finalUrl.startsWith('chrome-error://')) return 'proxy_failed';
  if (errorMessage.startsWith('ACCOUNT_PERSIST_FAILED')) return 'account_persist_failed';
  if (errorMessage.startsWith('PHONE_VERIFICATION_REQUIRED')) return 'phone_verification_required';
  if (errorMessage.startsWith('FINGERPRINT_INCONSISTENT')) return 'fingerprint_inconsistent';
  if (errorMessage.startsWith('DETECTION_TRIGGERED')) return 'detection_triggered';
  if (/signup_(did_not_complete|verification_incomplete|did_not_authenticate)/.test(errorMessage)) return 'registration_not_accepted';
  if (/captcha|challenge|checkpoint/i.test(finalUrl) || /captcha|challenge|checkpoint/i.test(errorMessage)) return 'captcha_challenge';
  if (/signup_form_unavailable/.test(errorMessage)) return 'form_unavailable';
  return 'action_failed';
}

export function linkedinRegisterExitCode(signal = '') {
  if (signal === 'detection_triggered' || signal === 'captcha_challenge') return 2;
  if (signal === 'proxy_failed') return 3;
  if (signal === 'phone_verification_required') return 4;
  if (signal === 'registration_not_accepted') return 4;
  if (signal === 'account_persist_failed') return 5;
  return 1;
}
