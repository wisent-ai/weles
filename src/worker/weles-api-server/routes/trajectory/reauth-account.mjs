// The account a Brama-ordered sign-in route acts on: admitted by Brama's own
// reauth token, named by provider, Skarbiec subscription and optionally its
// login item, resolved from Skarbiec, and unchanged since Brama resolved it.
// /reauth and /reauth/enrol-authenticator both refuse a request that fails
// any of these before a browser starts.
import { constants as http } from 'node:http2';
import { BRAMA_REAUTH_TOKEN } from '../../configuration.mjs';
import { readBody, reauthAuthorized } from '../../http-exchange.mjs';
import { REAUTH_PROVIDERS } from '../../run/process/reauth-process.mjs';
import { RUN_RELEASE_IDENTITY } from '../../release-identity.mjs';
import { RouteRefusal } from './refusal.mjs';

/** `value` trimmed when it is text, else empty. */
function statedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The refusal of a Skarbiec identity lookup, with the code and detail it carried when it had them. */
function identityRefusal(error) {
  return new RouteRefusal(
    http.HTTP_STATUS_CONFLICT,
    {
      ok: false,
      error:
        typeof error.code === 'string'
          ? error.code
          : 'skarbiec_identity_unavailable',
      stage: 'identity',
      message: error.message,
      ...(error.detail && typeof error.detail === 'object' ? error.detail : {}),
    },
    { cause: error },
  );
}

/** Refused unless the request carries Brama's reauth token, and the worker holds one to compare. */
export function requireReauthToken(req) {
  if (reauthAuthorized(req)) return;
  if (BRAMA_REAUTH_TOKEN)
    throw new RouteRefusal(http.HTTP_STATUS_UNAUTHORIZED, {
      ok: false,
      error: 'unauthorized',
    });
  throw new RouteRefusal(http.HTTP_STATUS_INTERNAL_SERVER_ERROR, {
    ok: false,
    error: 'missing_BRAMA_WELES_REAUTH_TOKEN',
  });
}

/**
 * The request's body, Skarbiec account and the identity it answers with;
 * a RouteRefusal names whatever the request lacks. `purpose` names what was
 * resolved, for the refusal of an account that changed since.
 */
export async function admittedReauthAccount(req, selectLoginAccount, purpose) {
  requireReauthToken(req);
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    throw new RouteRefusal(
      http.HTTP_STATUS_BAD_REQUEST,
      { ok: false, error: error.message },
      { cause: error },
    );
  }
  const provider = statedText(body.provider).toLowerCase();
  if (!REAUTH_PROVIDERS.has(provider))
    throw new RouteRefusal(http.HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error: `provider must be one of ${[...REAUTH_PROVIDERS].join('|')}`,
    });
  const subscriptionId = statedText(body.subscription_id);
  if (!subscriptionId)
    throw new RouteRefusal(http.HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error: 'subscription_id_required',
      stage: 'identity',
      message: 'An exact Skarbiec subscription id is required',
    });
  const loginItem = statedText(body.login_item);
  let account;
  try {
    account = loginItem
      ? selectLoginAccount(provider, loginItem, subscriptionId)
      : selectLoginAccount(provider, undefined, subscriptionId);
  } catch (error) {
    throw identityRefusal(error);
  }
  const identity = {
    subscription_id: account.subscriptionId,
    subscription_item: account.subscriptionItem,
    login_item: account.loginItem,
    provider: account.provider,
    account_ref: account.accountRef,
    login_method: account.loginMethod,
    account_revision: account.accountRevision,
    source_revision: RUN_RELEASE_IDENTITY.source_revision,
  };
  if (
    body.account_revision &&
    body.account_revision !== account.accountRevision
  )
    throw new RouteRefusal(http.HTTP_STATUS_CONFLICT, {
      ok: false,
      error: 'skarbiec_identity_changed',
      stage: 'identity',
      message: `Skarbiec account data changed after ${purpose} was resolved`,
      ...identity,
    });
  return { account, identity, provider };
}
