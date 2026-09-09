import { createHash } from 'node:crypto';
import { listCredentialItems, readDocument } from '../state/skarbiec-records.js';

export type LoginAccountProvider = 'claude' | 'codex' | 'kimi';

/** A projection of Skarbiec records, never a separately registered Weles account. */
export interface LoginAccount {
  loginItem: string;
  provider: LoginAccountProvider;
  displayName: string;
  subscriptionId: string;
  subscriptionItem: string;
  accountRef: string;
  loginMethod: string;
  sourceRevision: string;
}

export class LoginAccountSelectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LoginAccountSelectionError';
  }
}

type Item = Record<string, any>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const itemId = (item: Item): string => text(item.id ?? item.name);
const tag = (item: Item, prefix: string): string =>
  (Array.isArray(item.tags) ? item.tags : []).map((value: string) =>
    typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : '',
  ).find(Boolean) ?? '';
const providerName = (value: string): string => value === 'claude-code' ? 'claude' : value;
const sameAccount = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function fail(code: string, message: string, detail: Record<string, unknown>): never {
  throw new LoginAccountSelectionError(code, message, detail);
}

function metadata(item: Item): Item {
  const document = readDocument(itemId(item));
  const context = document.context ?? {};
  return {
    ...context,
    account_ref: text(context.account_ref) || text(document.fields?.username),
  };
}

function resolveAccount(subscription: Item, inventory: Item[], requested?: string | null): LoginAccount {
  const subscriptionItem = itemId(subscription);
  const subscriptionId = tag(subscription, 'brama:id:');
  const provider = providerName(tag(subscription, 'brama:provider:'));
  const context = metadata(subscription);
  let accountRef = text(context.account_ref);
  const explicit = text(requested) || text(context.login_item) || tag(subscription, 'brama:login:');
  const sourceItem = text(context.source_item);
  const logins = inventory.filter((item) => item.kind === 'login' || item.type === 'login');
  const sourceLogin = logins.find((item) => itemId(item) === sourceItem);
  const named = explicit || (sourceLogin ? sourceItem : '');
  const available = (named ? logins.filter((item) => itemId(item) === named) : logins)
    .map((item) => ({ item, context: metadata(item) }));
  if (!accountRef && named && available.length === 1) {
    accountRef = text(available[0].context.account_ref);
  }
  if (!accountRef && !named) {
    const sameProvider = available.filter((candidate) =>
      providerName(text(candidate.context.provider)) === provider);
    const subscriptions = inventory.filter((item) => Array.isArray(item.tags)
      && item.tags.includes('brama:subscription')
      && providerName(tag(item, 'brama:provider:')) === provider);
    if (subscriptions.length === 1 && sameProvider.length === 1) {
      accountRef = text(sameProvider[0].context.account_ref);
    }
  }
  if (!accountRef) fail('subscription_identity_missing',
    `Skarbiec subscription ${subscriptionItem} has neither an account identity nor an unambiguous login reference`,
    { subscription_id: subscriptionId, subscription_item: subscriptionItem,
      login_items: available.map(({ item }) => itemId(item)) });
  const candidates = available.filter((candidate) =>
    sameAccount(text(candidate.context.account_ref), accountRef));
  // A provider-specific login takes precedence over a shared SSO login for the
  // same principal. Neither provider nor principal is inferred from an item name.
  const direct = candidates.filter((candidate) =>
    providerName(text(candidate.context.provider)) === provider);
  const eligible = direct.length ? direct : candidates.filter((candidate) => {
    const method = text(candidate.context.login_method);
    return method === 'google_sso' || method === 'email_password' || Boolean(named);
  });
  if (eligible.length !== 1) fail(eligible.length ? 'skarbiec_login_ambiguous' : 'skarbiec_login_missing',
    `Skarbiec subscription ${subscriptionItem} identifies ${accountRef}, but ${eligible.length} login items match that identity`,
    { subscription_id: subscriptionId, subscription_item: subscriptionItem,
      account_ref: accountRef, requested_login_item: named || null,
      candidates: eligible.map(({ item }) => itemId(item)) });
  const login = eligible[0];
  const method = text(login.context.login_method) || text(context.login_method);
  if (!['google_sso', 'email_password'].includes(method)) fail('login_method_unsupported',
    `Skarbiec login ${itemId(login.item)} declares unsupported login_method ${method || '(absent)'}`,
    { subscription_id: subscriptionId, login_item: itemId(login.item), login_method: method });
  if (!['claude', 'codex', 'kimi'].includes(provider)) fail('subscription_provider_unsupported',
    `Skarbiec subscription ${subscriptionItem} declares unsupported provider ${provider}`,
    { subscription_id: subscriptionId, provider });
  const revision = createHash('sha256').update(JSON.stringify([
    subscription.item_uid ?? subscriptionItem, subscription.revision,
    login.item.item_uid ?? itemId(login.item), login.item.revision, method,
  ])).digest('hex');
  return {
    provider: provider as LoginAccountProvider,
    subscriptionId, subscriptionItem, loginItem: itemId(login.item),
    displayName: text(context.name) || accountRef,
    accountRef, loginMethod: method, sourceRevision: revision,
  };
}

/** Resolve an exact subscription from the live vault before any browser starts. */
export function selectLoginAccount(
  provider: string, loginItem?: string | null, subscriptionId?: string | null,
): LoginAccount {
  const inventory = listCredentialItems();
  const wanted = text(subscriptionId);
  const subscriptions = inventory.filter((item) =>
    Array.isArray(item.tags) && item.tags.includes('brama:subscription')
      && providerName(tag(item, 'brama:provider:')) === providerName(provider)
      && (!wanted || tag(item, 'brama:id:') === wanted));
  if (subscriptions.length !== 1) fail(
    subscriptions.length ? 'subscription_identity_ambiguous' : 'subscription_not_found',
    `Skarbiec lists ${subscriptions.length} subscriptions for ${provider}${wanted ? ` with id ${wanted}` : ''}; an exact subscription is required`,
    { provider, subscription_id: wanted || null,
      subscription_items: subscriptions.map(itemId) });
  return resolveAccount(subscriptions[0], inventory, loginItem);
}

/** Non-secret inspection; an unresolved record is an error, never an absent account. */
export function listLoginAccounts(): { accounts: LoginAccount[]; errors: Record<string, unknown>[] } {
  const inventory = listCredentialItems();
  const accounts: LoginAccount[] = [];
  const errors: Record<string, unknown>[] = [];
  for (const item of inventory.filter((item) => Array.isArray(item.tags)
    && item.tags.includes('brama:subscription')
    && ['claude-code', 'codex', 'kimi'].includes(tag(item, 'brama:provider:')))) {
    try { accounts.push(resolveAccount(item, inventory)); }
    catch (error) {
      if (!(error instanceof LoginAccountSelectionError)) throw error;
      errors.push({ code: error.code, detail: error.message, ...error.detail });
    }
  }
  return { accounts, errors };
}

/** Secret material is read only inside the authentication trajectory. */
export function readLoginMaterial(account: LoginAccount): {
  email: string; password: string; loginMethod: string; totpSecret?: string;
} {
  const document = readDocument(account.loginItem);
  const fields = document.fields ?? {};
  const email = text(fields.username);
  if (!sameAccount(email, account.accountRef)) fail('login_identity_changed',
    `Skarbiec login ${account.loginItem} changed identity after authentication was admitted`,
    { subscription_id: account.subscriptionId, login_item: account.loginItem });
  if (typeof fields.password !== 'string' || !fields.password) fail('login_password_missing',
    `Skarbiec login ${account.loginItem} has no password for the declared login method`,
    { subscription_id: account.subscriptionId, login_item: account.loginItem });
  return { email, password: fields.password, loginMethod: account.loginMethod,
    ...(text(fields.totp_secret) ? { totpSecret: text(fields.totp_secret) } : {}) };
}
