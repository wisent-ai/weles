import { createHash, createHmac } from 'node:crypto';
import { selectLoginAccount, readLoginMaterial } from '../../../../dist/utils/login-accounts.js';
import { requireCapabilities, loadFromSkarbiec, resolveBearer, stadoRouterUrl } from '../reauth_config.mjs';
import { bankBody, writePool } from '../subscription_pool.mjs';
import { beginOAuth, finishOAuth, AuthenticationFailure } from './oauth.mjs';
import { authorizeInBrowser } from './browser.mjs';

let stage = 'identity';
let browserStarted = false;
function mark(value) {
  stage = value;
  if (value === 'browser_started') browserStarted = true;
  process.stderr.write(`STEP ${value}\n`);
}

function selectedAccount(provider) {
  const subscription = process.env.BRAMA_SUBSCRIPTION_ID;
  if (!subscription) throw new AuthenticationFailure('subscription_id_required', 'identity',
    'The authentication request must name the Skarbiec subscription it renews');
  const account = selectLoginAccount(provider, process.env.WELES_LOGIN_ITEM, subscription);
  const admitted = process.env.WELES_ACCOUNT_SOURCE_REVISION;
  if (admitted && admitted !== account.sourceRevision) {
    throw new AuthenticationFailure('skarbiec_identity_changed', 'identity',
      'Skarbiec account data changed after authentication admission');
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

function fail(error, provider) {
  const failure = {
    code: error.code || (error.fatal2fa ? 'provider_challenge_refused' : 'authentication_failed'),
    stage: error.stage || stage,
    message: error.message,
    provider,
    browser_started: browserStarted,
    retryable: !browserStarted || error.code === 'oauth_transport_failed',
    http_status: error.status || null,
    subscription_id: process.env.BRAMA_SUBSCRIPTION_ID || null,
  };
  process.stderr.write(`AUTH_FAILURE ${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}

/** Weles login action: the grant stays in the worker's credential boundary. */
export async function login(provider) {
  try {
    const result = await authenticate(provider);
    process.stdout.write(`${JSON.stringify(result.credential)}\n`);
  } catch (error) { fail(error, provider); }
}

/** Renew one existing subscription, never import a provider CLI's local session. */
export async function reauthenticate(provider) {
  try {
    const { account, credential } = await authenticate(provider);
    mark('credential_persist');
    const configurationProvider = provider === 'claude' ? 'claude' : provider;
    const cfg = loadFromSkarbiec(`${configurationProvider}-reauth-config`);
    const body = bankBody({
      provider: provider === 'claude' ? 'claude-code' : provider,
      subscription_id: account.subscriptionId,
      api_key: JSON.stringify(credential),
      label: account.displayName,
    });
    const stamp = String(Math.floor(Date.now() / 1000));
    const hash = createHash('sha256').update(body).digest('hex');
    const signature = createHmac('sha256', cfg.hmacSecret).update(`${cfg.agentId}:${stamp}:${hash}`).digest('hex');
    const response = await writePool(stadoRouterUrl(), {
      authorization: `Bearer ${resolveBearer(cfg.agentId)}`,
      'content-type': 'application/json', 'x-agent-id': cfg.agentId,
      'x-agent-timestamp': stamp, 'x-agent-signature': signature,
    }, body);
    if (!response.ok) {
      throw new AuthenticationFailure('credential_persist_refused', 'credential_persist',
        `Brama refused the credential for ${account.subscriptionId}: ${await response.text()}`, response.status);
    }
    const answer = await response.json();
    const stored = answer.subscription ?? answer;
    if (stored.id !== account.subscriptionId) {
      throw new AuthenticationFailure('credential_coordinate_mismatch', 'credential_persist',
        'Brama stored the grant under a different subscription than the one authenticated');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, subscription_id: account.subscriptionId,
      subscription_item: account.subscriptionItem, login_item: account.loginItem,
      source_revision: account.sourceRevision, credential_persisted: true })}\n`);
  } catch (error) { fail(error, provider); }
}
