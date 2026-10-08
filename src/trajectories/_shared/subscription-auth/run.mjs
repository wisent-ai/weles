import {
  selectLoginAccount,
  readLoginMaterial,
  persistSubscriptionGrant,
} from '../../../../dist/utils/login-accounts.js';
import { requireCapabilities } from '../auth/capabilities.mjs';
import { beginOAuth, finishOAuth, AuthenticationFailure } from './oauth.mjs';
import { authorizeInBrowser } from './browser.mjs';
import { declaredRedirect } from './redirect.mjs';

let stage = 'identity';
let browserStarted = false;
let secondFactor = null;
function mark(value, observation = null) {
  stage = value;
  if (value === 'browser_started') browserStarted = true;
  if (
    observation &&
    (observation.required === true || secondFactor?.required !== true)
  ) {
    secondFactor = observation;
  }
  process.stderr.write(`STEP ${value}\n`);
}

function selectedAccount(provider) {
  const subscription = process.env.BRAMA_SUBSCRIPTION_ID;
  if (!subscription)
    throw new AuthenticationFailure(
      'subscription_id_required',
      'identity',
      'The authentication request must name the Skarbiec subscription it renews',
    );
  const account = selectLoginAccount(
    provider,
    process.env.WELES_LOGIN_ITEM,
    subscription,
  );
  const admitted = process.env.WELES_ACCOUNT_REVISION;
  if (admitted && admitted !== account.accountRevision) {
    throw new AuthenticationFailure(
      'skarbiec_identity_changed',
      'identity',
      'Skarbiec account data changed after authentication admission',
    );
  }
  return account;
}

async function authenticate(provider) {
  mark('identity');
  const account = selectedAccount(provider);
  const login = readLoginMaterial(account);
  requireCapabilities(`${provider}/login`);
  mark('oauth_start');
  const transaction = await beginOAuth(provider);
  mark('browser_login');
  const displayed = await authorizeInBrowser(account, login, transaction, mark);
  mark('token_exchange');
  const credential = await finishOAuth(transaction, login.email, displayed);
  return { account, credential };
}

// The trajectory frames of the error's stack: which of our calls failed. A
// browser error says what broke ("Execution context was destroyed") but not
// which read or click met it, and a recorded sign-in is not run twice alike.
function callSite(error) {
  return String(error?.stack || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => line.startsWith('at ') && line.includes('/trajectories/'),
    );
}

function fail(error, provider) {
  const observedBrowser = Object.hasOwn(error, 'browser_started')
    ? error.browser_started
    : browserStarted;
  const failure = {
    code:
      error.code ||
      (error.fatal2fa ? 'provider_challenge_refused' : 'authentication_failed'),
    stage: error.stage || stage,
    message: error.message,
    provider,
    browser_started: observedBrowser,
    second_factor: error.second_factor ?? secondFactor,
    retryable:
      observedBrowser === false || error.code === 'oauth_transport_failed',
    http_status: error.status || null,
    subscription_id: process.env.BRAMA_SUBSCRIPTION_ID || null,
    ...(typeof error.capability === 'string'
      ? { capability: error.capability }
      : {}),
    ...(typeof error.reason === 'string' ? { reason: error.reason } : {}),
    call_site: callSite(error),
  };
  process.stderr.write(`AUTH_FAILURE ${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}

/** Weles login action: the grant stays in the worker's credential boundary. */
export async function login(provider) {
  try {
    const result = await authenticate(provider);
    process.stdout.write(`${JSON.stringify(result.credential)}\n`);
  } catch (error) {
    fail(error, provider);
  }
}

/** Renew one existing subscription, never import a provider CLI's local session. */
export async function reauthenticate(provider) {
  try {
    const { account, credential } = await authenticate(provider);
    mark('credential_persist');
    persistSubscriptionGrant(account, credential);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        subscription_id: account.subscriptionId,
        subscription_item: account.subscriptionItem,
        login_item: account.loginItem,
        account_revision: account.accountRevision,
        credential_persisted: true,
        second_factor: secondFactor,
      })}\n`,
    );
  } catch (error) {
    fail(error, provider);
  }
}

/** Complete the authorization a harness started (`WELES_AUTHORIZE_URL`) as
 * the selected account, and print the provider's redirect for that harness. */
export async function authorizeForHarness(provider) {
  try {
    mark('identity');
    const account = selectedAccount(provider);
    const login = readLoginMaterial(account);
    requireCapabilities(`${provider}/account/authorize`);
    const url = process.env.WELES_AUTHORIZE_URL;
    if (!url)
      throw new AuthenticationFailure(
        'authorize_url_required',
        'identity',
        'The authorization request must carry the authorize URL the harness printed',
      );
    mark('browser_login');
    const redirect = await authorizeInBrowser(
      account,
      login,
      { provider, url, redirectUri: declaredRedirect(url) },
      mark,
    );
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        subscription_id: account.subscriptionId,
        login_item: account.loginItem,
        redirect_url: redirect,
      })}\n`,
    );
  } catch (error) {
    fail(error, provider);
  }
}

/** Sign `account` in for Brama inside a browser session already signed in
 * to the provider, and persist the grant on its subscription item. */
export async function signInWithin(provider, account, session) {
  const login = readLoginMaterial(account);
  mark('oauth_start');
  const transaction = await beginOAuth(provider);
  const displayed = await authorizeInBrowser(
    account,
    login,
    transaction,
    mark,
    session,
  );
  mark('token_exchange');
  const credential = await finishOAuth(transaction, login.email, displayed);
  mark('credential_persist');
  persistSubscriptionGrant(account, credential);
}

export { fail as reportFailure, mark as markStage };
