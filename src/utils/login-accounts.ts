import { createHash } from 'node:crypto';
import { listCredentialItems, readDocument, writeDocument } from '../state/skarbiec-records.js';

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
  accountRevision: string;
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
/**
 * The slug Brama's pool builds a member id from: lowercase, and every
 * character that is not an ASCII letter or digit becomes a hyphen
 * (`gateway/broker.rs: slug`). `brama subscription sync` mints one member
 * per held account as `brama-sub-held-<provider-slug>-<account-slug>`, so a
 * member imported before accounts were recorded beside the grant still says
 * which account it is — in its own id.
 */
const slug = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]/g, '-');

/**
 * The account a member id names, matched forward: every candidate login's
 * own `account_ref` is slugged the same way and compared with the id's
 * suffix. Nothing is derived from the slug itself — a slug cannot be turned
 * back into an address — and a suffix that matches no login, or more than
 * one, yields nothing, so the caller's refusal stands.
 *
 * This is what an account imported before 2026-09-18 lacks: those members
 * carry no `account_ref`, `/readyz` reports each as
 * `subscription_identity_missing`, and the automatic sign-in that exists to
 * replace their burnt grants cannot start at all.
 */
function accountFromSubscriptionId(
  subscriptionId: string,
  candidates: { context: Item }[],
): string {
  if (!subscriptionId) return '';
  const matches = candidates
    .map(({ context }) => text(context.account_ref))
    .filter((ref) => ref && subscriptionId.endsWith(`-${slug(ref)}`));
  const distinct = [...new Set(matches.map((ref) => ref.toLowerCase()))];
  return distinct.length === 1 ? matches[0] : '';
}

function fail(code: string, message: string, detail: Record<string, unknown>): never {
  throw new LoginAccountSelectionError(code, message, detail);
}

function metadata(item: Item, provider = providerName(tag(item, 'brama:provider:'))): Item {
  const document = readDocument(itemId(item));
  const context = document.context ?? {};
  let value = document.fields?.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = undefined; }
  }
  let declared = value?.metadata;
  if (typeof declared === 'string') declared = JSON.parse(declared);
  return {
    ...context,
    login_item: text(context.login_item) || text(declared?.login_item)
      || text(declared?.[`${provider.toUpperCase()}_SERVICE_CREDENTIAL_ID`]),
    account_ref: text(context.account_ref) || text(document.fields?.username),
    credentialDigest: createHash('sha256').update(JSON.stringify([
      document.fields?.username?.toLowerCase(), document.fields?.password,
    ])).digest('hex'),
    authenticatorDigest: document.fields?.totp_secret
      ? createHash('sha256').update(document.fields.totp_secret).digest('hex') : null,
  };
}

/** A subscription can name a canonical descriptor which names its login. */
function subscriptionMetadata(subscription: Item, inventory: Item[], provider: string): Item {
  const result = metadata(subscription);
  const visited = new Set([itemId(subscription)]);
  const revisions: unknown[] = [];
  let source = text(result.source_item);
  while (source && !text(result.account_ref) && !text(result.login_item)) {
    if (visited.has(source)) fail('subscription_source_cycle',
      `Skarbiec subscription ${itemId(subscription)} has a cyclic source reference at ${source}`,
      { subscription_item: itemId(subscription), source_item: source });
    visited.add(source);
    const item = inventory.find(candidate => itemId(candidate) === source || candidate.item_uid === source);
    if (!item) fail('subscription_source_missing',
      `Skarbiec subscription ${itemId(subscription)} names missing source item ${source}`,
      { subscription_item: itemId(subscription), source_item: source });
    const declared = metadata(item, provider);
    revisions.push([item.item_uid ?? itemId(item), item.revision]);
    if (item.kind === 'login' || item.type === 'login') {
      result.login_item = itemId(item);
    } else {
      result.login_item = text(declared.login_item);
    }
    result.account_ref = text(declared.account_ref);
    source = text(declared.source_item);
  }
  result.source_revisions = revisions;
  return result;
}

function resolveAccount(subscription: Item, inventory: Item[], requested?: string | null): LoginAccount {
  const subscriptionItem = itemId(subscription);
  const subscriptionId = tag(subscription, 'brama:id:');
  const provider = providerName(tag(subscription, 'brama:provider:'));
  const context = subscriptionMetadata(subscription, inventory, provider);
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
  if (!accountRef) {
    const sameProvider = available.filter((candidate) =>
      providerName(text(candidate.context.provider)) === provider);
    accountRef = accountFromSubscriptionId(subscriptionId, sameProvider);
  }
  if (!accountRef) {
    const names = available.map(({ item }) => itemId(item));
    // The way out belongs in the sentence. The candidate logins were already
    // in the refusal's detail and nowhere an operator reads: on 2026-09-20
    // `brama subscription sign-in claude-code --subscription-id
    // brama-sub-wisent-app-claude-secondary` printed this message alone, and
    // the two claude logins this vault holds had to be found with
    // `skarbiec list`.
    fail('subscription_identity_missing',
      `Skarbiec subscription ${subscriptionItem} has neither an account identity nor an `
      + 'unambiguous login reference; '
      + (names.length
        ? `name one of its logins with --login-item: ${names.join(', ')}`
        : 'this vault holds no login item to name'),
      { subscription_id: subscriptionId, subscription_item: subscriptionItem,
        login_items: names });
  }
  const candidates = available.filter((candidate) =>
    sameAccount(text(candidate.context.account_ref), accountRef));
  // A provider-specific login takes precedence over a shared SSO login for the
  // same principal. Neither provider nor principal is inferred from an item name.
  const direct = candidates.filter((candidate) =>
    providerName(text(candidate.context.provider)) === provider);
  const google = candidates.filter((candidate) => candidate.context.login_method === 'google_sso');
  const eligible = direct.length ? direct : google.length ? google : named ? candidates : [];
  const credentials = new Set(eligible.map((candidate) => candidate.context.credentialDigest));
  const authenticators = new Set(eligible.map((candidate) => candidate.context.authenticatorDigest).filter(Boolean));
  if (!eligible.length || credentials.size !== 1 || authenticators.size > 1) {
    fail(eligible.length ? 'skarbiec_login_ambiguous' : 'skarbiec_login_missing',
      `Skarbiec subscription ${subscriptionItem} identifies ${accountRef}, but its login material is ${eligible.length ? 'inconsistent across matching records' : 'missing'}`,
      { subscription_id: subscriptionId, subscription_item: subscriptionItem,
        account_ref: accountRef, candidates: eligible.map(({ item }) => itemId(item)) });
  }
  // Equivalent records describe the same principal and credential, not
  // different accounts. Prefer one carrying the stored authenticator, then
  // its immutable identity so renaming does not elect a different credential.
  eligible.sort((left, right) => Number(Boolean(right.context.authenticatorDigest))
    - Number(Boolean(left.context.authenticatorDigest))
    || String(left.item.item_uid ?? itemId(left.item)).localeCompare(String(right.item.item_uid ?? itemId(right.item))));
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
    login.item.item_uid ?? itemId(login.item), login.item.revision, method, context.source_revisions,
  ])).digest('hex');
  return {
    provider: provider as LoginAccountProvider,
    subscriptionId, subscriptionItem, loginItem: itemId(login.item),
    displayName: text(context.name) || accountRef,
    accountRef, loginMethod: method, accountRevision: revision,
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

/** Persist only the grant on the selected subscription; preserve account metadata. */
export function persistSubscriptionGrant(account: LoginAccount, credential: Record<string, unknown>): void {
  const current = selectLoginAccount(account.provider, account.loginItem, account.subscriptionId);
  if (current.accountRevision !== account.accountRevision) fail('skarbiec_identity_changed',
    'Skarbiec changed while the provider authentication was running; the existing credential was not overwritten',
    { subscription_id: account.subscriptionId, subscription_item: account.subscriptionItem });
  const document = readDocument(account.subscriptionItem);
  const encoded = JSON.stringify(credential);
  document.fields.value = encoded;
  document.context = { ...document.context, account_ref: account.accountRef,
    provider: account.provider === 'claude' ? 'claude-code' : account.provider,
    login_method: account.loginMethod };
  writeDocument(account.subscriptionItem, document);
  if (readDocument(account.subscriptionItem).fields?.value !== encoded) fail('credential_persist_unconfirmed',
    'Skarbiec did not return the credential just written for the selected subscription',
    { subscription_id: account.subscriptionId, subscription_item: account.subscriptionItem });
}
