// What a login account is, how a refusal to resolve one is reported, and
// what one vault item and the subscription's chain of source items declare
// about the login behind it.
import { createHash } from 'node:crypto';
import { readDocument } from '../../state/skarbiec-records.js';
import {
  itemId,
  providerName,
  sameAccount,
  tag,
  text,
  type Item,
} from './identity.js';

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

/** How a login row may sign in: through Google, with a password, or with the
 * one-time code the provider mails to an inbound address Weles reads (the
 * accounts an acquisition buys). */
export const LOGIN_METHODS = ['google_sso', 'email_password', 'email_code'];

/** The kind of vault item that holds sign-in material. */
const LOGIN_KIND = 'login';

/** Whether a vault item is a login, by its kind or its legacy type. */
export function isLogin(item: Item): boolean {
  return item.kind === LOGIN_KIND || item.type === LOGIN_KIND;
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

export function fail(
  code: string,
  message: string,
  detail: Record<string, unknown>,
): never {
  throw new LoginAccountSelectionError(code, message, detail);
}

/** One place a vault item may declare a field, and what it says there. */
interface Declared {
  where: string;
  value: string;
}

/**
 * The one value `item` declares for `field` across the places it may be
 * written. A place that is empty says nothing; two places that say different
 * things, as `same` compares them, are refused with every place and what it
 * says, because letting the first non-empty one win let a stale tag or
 * legacy metadata decide which login a sign-in drives.
 */
function agreed(
  item: Item,
  field: string,
  places: Declared[],
  same: (left: string, right: string) => boolean = (left, right) =>
    left === right,
): string {
  const said = places.filter(({ value }) => value);
  const [first, ...rest] = said;
  if (!first) return '';
  if (rest.some(({ value }) => !same(value, first.value)))
    fail(
      'login_record_conflict',
      `Skarbiec item ${itemId(item)} declares ${field} differently in ${said.map(({ where, value }) => `${where} (${value})`).join(', ')}; keep one`,
      {
        item: itemId(item),
        field,
        places: Object.fromEntries(
          said.map(({ where, value }) => [where, value]),
        ),
      },
    );
  return first.value;
}

/** `raw` read as JSON when it is a string, refused naming `item` and `what`
 * when it does not parse; a value that is not a string is already read. */
function parsed(item: Item, what: string, raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(
      'login_record_unreadable',
      `Skarbiec item ${itemId(item)} holds ${what} that is not JSON: ${(error as Error).message}`,
      { item: itemId(item), field: what },
    );
  }
}

/** The member `name` of a parsed object, or nothing when the value is no
 * object or does not carry it. */
function member(value: unknown, name: string): unknown {
  if (value !== null && typeof value === 'object' && name in value)
    return (value as Record<string, unknown>)[name];
}

export function metadata(
  item: Item,
  provider = providerName(tag(item, 'brama:provider:')),
): Item {
  const document = readDocument(itemId(item));
  const context = document.context;
  const value = parsed(item, 'fields.value', document.fields?.value);
  const declared = parsed(
    item,
    'fields.value metadata',
    member(value, 'metadata'),
  );
  const legacyItem = `${provider.toUpperCase()}_SERVICE_CREDENTIAL_ID`;
  return {
    ...context,
    login_method: agreed(item, 'login_method', [
      { where: 'context.login_method', value: text(context?.login_method) },
      {
        where: 'the weles:login-method: tag',
        value: tag(item, 'weles:login-method:'),
      },
    ]),
    login_item: agreed(item, 'login_item', [
      { where: 'context.login_item', value: text(context?.login_item) },
      {
        where: 'metadata.login_item',
        value: text(member(declared, 'login_item')),
      },
      {
        where: `metadata.${legacyItem}`,
        value: text(member(declared, legacyItem)),
      },
    ]),
    account_ref: agreed(
      item,
      'account_ref',
      [
        { where: 'context.account_ref', value: text(context?.account_ref) },
        { where: 'fields.username', value: text(document.fields?.username) },
      ],
      sameAccount,
    ),
    credentialDigest: createHash('sha256')
      .update(
        JSON.stringify([
          document.fields?.username?.toLowerCase(),
          document.fields?.password,
        ]),
      )
      .digest('hex'),
    authenticatorDigest: document.fields?.totp_secret
      ? createHash('sha256').update(document.fields.totp_secret).digest('hex')
      : null,
  };
}

/** A subscription can name a canonical descriptor which names its login. */
export function subscriptionMetadata(
  subscription: Item,
  inventory: Item[],
  provider: string,
): Item {
  const result = metadata(subscription);
  const visited = new Set([itemId(subscription)]);
  const revisions: unknown[] = [];
  let source = text(result.source_item);
  while (source && !text(result.account_ref) && !text(result.login_item)) {
    if (visited.has(source))
      fail(
        'subscription_source_cycle',
        `Skarbiec subscription ${itemId(subscription)} has a cyclic source reference at ${source}`,
        { subscription_item: itemId(subscription), source_item: source },
      );
    visited.add(source);
    const item = inventory.find(
      (candidate) =>
        itemId(candidate) === source || candidate.item_uid === source,
    );
    if (!item)
      fail(
        'subscription_source_missing',
        `Skarbiec subscription ${itemId(subscription)} names missing source item ${source}`,
        { subscription_item: itemId(subscription), source_item: source },
      );
    const declared = metadata(item, provider);
    revisions.push([item.item_uid ?? itemId(item), item.revision]);
    if (isLogin(item)) {
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
