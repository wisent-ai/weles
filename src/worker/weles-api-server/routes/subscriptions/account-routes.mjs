// The two runs Brama orders for one subscription account besides a sign-in.
//
// POST /subscriptions/acquire buys a new provider account: a fresh identity on
// an inbound domain Weles reads, the provider's sign-up, the plan Brama names
// paid with the card Skarbiec holds, the login row and the subscription item
// written to the vault, and the account signed in for Brama. POST
// /reauth/authorize completes one OAuth authorization a coding-agent harness
// started for an account the pool already holds, and answers the provider's
// redirect so the harness mints its own grant.
//
// Both are admitted by Brama's own token, never the general API token, for the
// reason /reauth is: each spends a real browser run on exactly one account and
// the broker decides which. Both answer one JSON object per line, exactly as
// /reauth does, ending with `result`.

import { constants as http } from 'node:http2';

import { BRAMA_REAUTH_TOKEN } from '../../configuration.mjs';
import { json, readBody, reauthAuthorized } from '../../http-exchange.mjs';
import { coalesceRun, runAdmissionKey } from '../../run/run-outcome.mjs';
import { providersWith, runReauth, trajectoryPath } from '../../run/trajectory-process.mjs';
import { RUN_RELEASE_IDENTITY } from '../../release-identity.mjs';
import { REAUTH_PROGRESS_CONTENT_TYPE } from '../trajectory-routes.mjs';
import { AUTHORIZE_PAGES } from '../../../../trajectories/_shared/subscription-auth/oauth.mjs';

/** The trajectory under src/trajectories/<provider>/ that buys an account:
 * a provider is bought for exactly when it has one. */
const ACQUIRE_TRAJECTORY = 'account/acquire';

/** The host a harness's own callback listener answers on. */
const HARNESS_CALLBACK_HOST = 'localhost';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function admit(req, res) {
  if (reauthAuthorized(req)) return true;
  json(
    res,
    BRAMA_REAUTH_TOKEN
      ? http.HTTP_STATUS_UNAUTHORIZED
      : http.HTTP_STATUS_INTERNAL_SERVER_ERROR,
    {
      ok: false,
      error: BRAMA_REAUTH_TOKEN
        ? 'unauthorized'
        : 'missing_BRAMA_WELES_REAUTH_TOKEN',
    },
  );
  return false;
}

function refuse(res, error, message) {
  json(res, http.HTTP_STATUS_BAD_REQUEST, { ok: false, error, message });
}

// What the run's last JSON line said, or the failure that it printed none.
function verdict(out, answer) {
  const said = out.answer;
  if (said)
    return {
      ok: out.ok === true && said.ok === true,
      failure: out.failure ?? said.failure,
      ...answer(said),
    };
  if (out.failure) return { ok: false, failure: out.failure };
  return {
    ok: false,
    failure: {
      code: 'run_result_missing',
      message: 'the run ended without printing its result line',
    },
  };
}

// One admitted run, streamed: `admitted`, everything the run reports, then
// `result`. A caller that joins a run already under way is sent what it has
// reported so far.
async function stream(res, key, identity, start, answer) {
  const hub = { events: [], listeners: new Set() };
  const admission = coalesceRun(
    key,
    () =>
      start((event) => {
        hub.events.push(event);
        for (const listener of hub.listeners) listener(event);
      }),
    hub,
  );
  const progress = admission.entry.metadata;
  res.writeHead(http.HTTP_STATUS_OK, {
    'Content-Type': REAUTH_PROGRESS_CONTENT_TYPE,
    'Cache-Control': 'no-store',
  });
  const send = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  send({ event: 'admitted', coalesced: admission.joined, ...identity });
  for (const event of progress.events) send(event);
  progress.listeners.add(send);
  let out;
  try {
    out = await admission.entry.promise;
  } catch (error) {
    out = {
      ok: false,
      failure: { code: 'run_failed', message: String(error?.message || error) },
    };
  } finally {
    progress.listeners.delete(send);
  }
  send({
    event: 'result',
    run_id: out.run_id,
    stages: out.stages,
    ...verdict(out, answer),
    ...identity,
    coalesced: admission.joined,
  });
  res.end();
}

export async function respondToAcquire(req, res) {
  if (!admit(req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    refuse(res, 'body_unreadable', e.message);
    return;
  }
  const provider = text(body.provider).toLowerCase();
  if (!trajectoryPath(provider, ACQUIRE_TRAJECTORY)) {
    refuse(
      res,
      'provider_unsupported',
      `Weles has no src/trajectories/${provider}/${ACQUIRE_TRAJECTORY}.mjs, so it cannot buy a "${provider}" account; it buys accounts of ${providersWith(ACQUIRE_TRAJECTORY).join(', ')}`,
    );
    return;
  }
  const subscriptionId = text(body.subscription_id);
  const planTier = text(body.plan_tier);
  const reason = text(body.reason);
  const missing = [
    ['subscription_id', subscriptionId],
    ['plan_tier', planTier],
    ['reason', reason],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    refuse(
      res,
      'acquisition_incomplete',
      `an acquisition names ${missing.join(', ')}; the request did not`,
    );
    return;
  }
  const identity = {
    provider,
    subscription_id: subscriptionId,
    plan_tier: planTier,
    source_revision: RUN_RELEASE_IDENTITY.source_revision,
  };
  await stream(
    res,
    runAdmissionKey('acquire', { provider, subscription_id: subscriptionId }),
    identity,
    (onProgress) =>
      runReauth(provider, null, onProgress, ACQUIRE_TRAJECTORY, {
        BRAMA_SUBSCRIPTION_ID: subscriptionId,
        WELES_PLAN_TIER: planTier,
        WELES_ACQUISITION_REASON: reason,
      }),
    (said) => ({
      account: said.account,
      subscription_item: said.subscription_item,
      login_item: said.login_item,
      paid: said.paid,
    }),
  );
}

// The authorize URL is the harness's own: only the provider's authorize page
// is driven, and only a redirect back to the harness's own callback listener
// is answered, so this route cannot be pointed at another site or used to
// send a code anywhere but to the caller that started the authorization.
function authorizeUrlRefusal(provider, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'authorize_url is not a URL';
  }
  const page = AUTHORIZE_PAGES[provider];
  if (`${url.origin}${url.pathname}` !== page)
    return `authorize_url must be ${page}; it is ${url.origin}${url.pathname}`;
  const declared = url.searchParams.get('redirect_uri');
  if (!declared) return 'authorize_url names no redirect_uri';
  let redirect;
  try {
    redirect = new URL(declared);
  } catch {
    return `authorize_url's redirect_uri ${declared} is not a URL`;
  }
  if (redirect.hostname !== HARNESS_CALLBACK_HOST)
    return `the authorization must redirect to the harness's own ${HARNESS_CALLBACK_HOST} listener; it redirects to ${redirect.host}`;
  return null;
}

export async function respondToAuthorize(req, res, selectLoginAccount) {
  if (!admit(req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    refuse(res, 'body_unreadable', e.message);
    return;
  }
  const provider = text(body.provider).toLowerCase();
  const subscriptionId = text(body.subscription_id);
  const authorizeUrl = text(body.authorize_url);
  if (
    !Object.hasOwn(AUTHORIZE_PAGES, provider) ||
    !subscriptionId ||
    !authorizeUrl
  ) {
    refuse(
      res,
      'authorization_incomplete',
      `an authorization names a provider (${Object.keys(AUTHORIZE_PAGES).join(', ')}), a subscription_id and an authorize_url`,
    );
    return;
  }
  const refusal = authorizeUrlRefusal(provider, authorizeUrl);
  if (refusal) {
    refuse(res, 'authorize_url_refused', refusal);
    return;
  }
  let account;
  try {
    account = selectLoginAccount(provider, undefined, subscriptionId);
  } catch (e) {
    json(res, http.HTTP_STATUS_CONFLICT, {
      ok: false,
      error: e.code,
      stage: 'identity',
      message: e.message,
      ...e.detail,
    });
    return;
  }
  const identity = {
    provider,
    subscription_id: account.subscriptionId,
    login_item: account.loginItem,
    account_ref: account.accountRef,
    source_revision: RUN_RELEASE_IDENTITY.source_revision,
  };
  await stream(
    res,
    runAdmissionKey('authorize', { provider, authorize_url: authorizeUrl }),
    identity,
    (onProgress) =>
      runReauth(provider, account, onProgress, 'account/authorize', {
        WELES_AUTHORIZE_URL: authorizeUrl,
      }),
    (said) => ({ redirect_url: said.redirect_url }),
  );
}

// POST /reauth/accounts: the accounts of one provider the vault's
// subscriptions resolve to, with no secret: subscription id, account and
// login row. A machine that holds no vault of its own (the operator's laptop)
// reads them here to know which accounts its harness lacks, because Weles
// resolves them from the same vault it completes their authorization from.
// Subscriptions that do not resolve are in `errors` with their own refusal.
export async function respondToAccounts(req, res, listLoginAccounts) {
  if (!admit(req, res)) return;
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    refuse(res, 'body_unreadable', e.message);
    return;
  }
  const provider = text(body.provider).toLowerCase();
  if (!Object.hasOwn(AUTHORIZE_PAGES, provider)) {
    refuse(
      res,
      'provider_unsupported',
      `Weles lists accounts of ${Object.keys(AUTHORIZE_PAGES).join(', ')}; "${provider}" is not one of them`,
    );
    return;
  }
  // `errors` holds every subscription of every provider that did not
  // resolve: an unresolved one names no provider account to filter it by.
  const listed = listLoginAccounts();
  json(res, http.HTTP_STATUS_OK, {
    ok: true,
    provider,
    accounts: listed.accounts
      .filter((account) => account.provider === provider)
      .map((account) => ({
        subscription_id: account.subscriptionId,
        account: account.accountRef,
        login_item: account.loginItem,
      })),
    errors: listed.errors,
  });
}
