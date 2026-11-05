// The login accounts Weles signs subscriptions in with, read from Skarbiec:
// selecting one, listing them, reading a login's material inside the
// authentication trajectory, and persisting the grant it earned.
import {
  listCredentialItems,
  readDocument,
  writeDocument,
} from '../state/skarbiec-records.js';
import {
  itemId,
  providerName,
  sameAccount,
  tag,
  text,
} from './login-accounts/identity.js';
import {
  fail,
  LoginAccountSelectionError,
  metadata,
  type LoginAccount,
} from './login-accounts/records.js';
import { resolveAccount } from './login-accounts/resolve.js';

export {
  LOGIN_METHODS,
  LoginAccountSelectionError,
  type LoginAccount,
  type LoginAccountProvider,
} from './login-accounts/records.js';

/** The Brama provider tags whose subscriptions Weles lists. */
const LISTED_PROVIDER_TAGS: Readonly<Record<string, true>> = {
  'claude-code': true,
  codex: true,
  kimi: true,
};

/**
 * Whether `provider` (as Weles names it, the directory its sign-in
 * trajectories live in) is one whose Brama subscriptions Weles lists.
 */
export function listsSubscriptionsFor(provider: string): boolean {
  return Object.keys(LISTED_PROVIDER_TAGS).some(
    (listed) => providerName(listed) === provider,
  );
}

/** Resolve an exact subscription from the live vault before any browser starts. */
export function selectLoginAccount(
  provider: string,
  loginItem?: string | null,
  subscriptionId?: string | null,
): LoginAccount {
  const inventory = listCredentialItems();
  const wanted = text(subscriptionId);
  const subscriptions = inventory.filter(
    (item) =>
      Array.isArray(item.tags) &&
      item.tags.includes('brama:subscription') &&
      providerName(tag(item, 'brama:provider:')) === providerName(provider) &&
      (!wanted || tag(item, 'brama:id:') === wanted),
  );
  const [only, ...others] = subscriptions;
  if (!only || others.length)
    fail(
      subscriptions.length
        ? 'subscription_identity_ambiguous'
        : 'subscription_not_found',
      `Skarbiec lists ${subscriptions.length} subscriptions for ${provider}${wanted ? ` with id ${wanted}` : ''}; an exact subscription is required`,
      {
        provider,
        subscription_id: wanted,
        subscription_items: subscriptions.map(itemId),
      },
    );
  return resolveAccount(only, inventory, loginItem);
}

/** How one login item signs in, from its own declaration: its context's
 * `login_method`, else its `weles:login-method:` tag; empty when it declares
 * none. The authenticator enrolment reads it for every caller, by
 * subscription or by login item alike. */
export function loginItemMethod(loginItem: string): string {
  const item = listCredentialItems().find(
    (candidate) =>
      itemId(candidate) === loginItem || candidate.item_uid === loginItem,
  );
  if (!item)
    fail('login_item_not_found', `Skarbiec lists no login item ${loginItem}`, {
      login_item: loginItem,
    });
  return text(metadata(item).login_method);
}

/** Non-secret inspection; an unresolved record is an error, never an absent account. */
export function listLoginAccounts(): {
  accounts: LoginAccount[];
  errors: Record<string, unknown>[];
} {
  const inventory = listCredentialItems();
  const accounts: LoginAccount[] = [];
  const errors: Record<string, unknown>[] = [];
  for (const item of inventory.filter(
    (item) =>
      Array.isArray(item.tags) &&
      item.tags.includes('brama:subscription') &&
      Object.hasOwn(LISTED_PROVIDER_TAGS, tag(item, 'brama:provider:')),
  )) {
    try {
      accounts.push(resolveAccount(item, inventory));
    } catch (error) {
      if (!(error instanceof LoginAccountSelectionError)) throw error;
      errors.push({ code: error.code, detail: error.message, ...error.detail });
    }
  }
  return { accounts, errors };
}

/** Secret material is read only inside the authentication trajectory. */
export function readLoginMaterial(account: LoginAccount): {
  email: string;
  password: string;
  loginMethod: string;
  loginItem: string;
  totpSecret?: string;
} {
  const document = readDocument(account.loginItem);
  const { fields } = document;
  if (!fields)
    fail(
      'login_fields_missing',
      `Skarbiec login ${account.loginItem} holds no fields to sign in with`,
      {
        subscription_id: account.subscriptionId,
        login_item: account.loginItem,
      },
    );
  const email = text(fields.username);
  if (!sameAccount(email, account.accountRef))
    fail(
      'login_identity_changed',
      `Skarbiec login ${account.loginItem} changed identity after authentication was admitted`,
      {
        subscription_id: account.subscriptionId,
        login_item: account.loginItem,
      },
    );
  if (
    account.loginMethod !== 'email_code' &&
    (typeof fields.password !== 'string' || !fields.password)
  )
    fail(
      'login_password_missing',
      `Skarbiec login ${account.loginItem} has no password for the declared login method`,
      {
        subscription_id: account.subscriptionId,
        login_item: account.loginItem,
      },
    );
  return {
    email,
    password: typeof fields.password === 'string' ? fields.password : '',
    loginMethod: account.loginMethod,
    loginItem: account.loginItem,
    ...(text(fields.totp_secret)
      ? { totpSecret: text(fields.totp_secret) }
      : {}),
  };
}

/** Persist only the grant on the selected subscription; preserve account metadata. */
export function persistSubscriptionGrant(
  account: LoginAccount,
  credential: Record<string, unknown>,
): void {
  const current = selectLoginAccount(
    account.provider,
    account.loginItem,
    account.subscriptionId,
  );
  if (current.accountRevision !== account.accountRevision)
    fail(
      'skarbiec_identity_changed',
      'Skarbiec changed while the provider authentication was running; the existing credential was not overwritten',
      {
        subscription_id: account.subscriptionId,
        subscription_item: account.subscriptionItem,
      },
    );
  const document = readDocument(account.subscriptionItem);
  const encoded = JSON.stringify(credential);
  document.fields.value = encoded;
  document.context = {
    ...document.context,
    account_ref: account.accountRef,
    provider: account.provider === 'claude' ? 'claude-code' : account.provider,
    login_method: account.loginMethod,
  };
  writeDocument(account.subscriptionItem, document);
  if (readDocument(account.subscriptionItem).fields?.value !== encoded)
    fail(
      'credential_persist_unconfirmed',
      'Skarbiec did not return the credential just written for the selected subscription',
      {
        subscription_id: account.subscriptionId,
        subscription_item: account.subscriptionItem,
      },
    );
}
