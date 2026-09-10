// Google SSO driver for service-credential balance trajectories.
// Many proxy/captcha/SMS providers expose only a "Sign in with Google" button.
// Caller must already have clicked the provider's "Sign in with Google" button
// and the page must now be on accounts.google.com (or about to redirect there).
//
// The sign-in itself is three steps in the order Google runs them: reaching the
// password field, submitting the password, and watching for the redirect back to
// the caller's site. Google's second factor, the page diagnostics those steps
// log, the stored TOTP secret they answer it from, and the service account
// record the balance is written to are modules beside them.
import { reachGooglePasswordStep } from './google_sso/sign_in/entry.mjs';
import { submitGooglePassword } from './google_sso/sign_in/password.mjs';
import { watchGoogleRedirect } from './google_sso/sign_in/redirect_watch.mjs';

export { generateTotp } from './google_sso/totp_secret.mjs';
export {
  getGoogleSsoCreds,
  getScopedGoogleLogin,
  parseBalanceFromText,
  patchServiceBalance,
} from './google_sso/service_account.mjs';

/**
 * Drive Google's identifier → password → consent sequence.
 * @param {object} session - WSession instance (we use session.page).
 * @param {{ email: string, password: string, totpSecret?: string, totp_secret?: string, metadata?: object }} creds
 * @param {{ originHost?: string }} opts - originHost (e.g. "dashboard.iproyal.com") for the post-login redirect check.
 * @returns {Promise<boolean>} true on success, false on detectable failure.
 */
export async function googleSso(session, creds, opts = {}) {
  // If caller passes opts.page (e.g. a popup), drive that page; otherwise the
  // session's main page. Caller is responsible for capturing popups before
  // calling this helper since on('page') listeners attach too late if added
  // here.
  const page = opts.page ?? session.page;

  const arrival = await reachGooglePasswordStep(page, creds);
  // Google finished the handoff on its own — an account it already knew, or a
  // consent screen it accepted — and the browser is back on the caller's site.
  if (arrival.at === 'caller_site') return true;
  if (arrival.at === 'refused') return false;

  const submitted = await submitGooglePassword(page, creds, arrival.passwordFieldCount);
  if (!submitted) return false;

  return await watchGoogleRedirect(page, session, creds, opts);
}
