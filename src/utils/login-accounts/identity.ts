// Reading identity out of a Skarbiec record: the small accessors, the slug
// Brama's pool builds a member id from, and the account a member id names.
//
// Split out of `utils/login-accounts.ts`, which had grown past the
// three-hundred-line limit; resolving and persisting stay there.

export type Item = Record<string, any>;

/** One reading of a member id that yields exactly one account. */
const ONE_ACCOUNT = 1;

export const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const itemId = (item: Item): string => text(item.id ?? item.name);

export const tag = (item: Item, prefix: string): string =>
  (Array.isArray(item.tags) ? item.tags : []).map((value: string) =>
    typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : '',
  ).find(Boolean) ?? '';

export const providerName = (value: string): string => value === 'claude-code' ? 'claude' : value;

export const sameAccount = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * The slug Brama's pool builds a member id from: lowercase, and every
 * character that is not an ASCII letter or digit becomes a hyphen
 * (`gateway/broker.rs: slug`). `brama subscription sync` mints one member
 * per held account as `brama-sub-held-<provider-slug>-<account-slug>`, so a
 * member imported before accounts were recorded beside the grant still says
 * which account it is — in its own id.
 */
export const slug = (value: string): string =>
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
export function accountFromSubscriptionId(
  subscriptionId: string,
  candidates: { context: Item }[],
): string {
  if (!subscriptionId) return '';
  const matches = candidates
    .map(({ context }) => text(context.account_ref))
    .filter((ref) => ref && subscriptionId.endsWith(`-${slug(ref)}`));
  const distinct = [...new Set(matches.map((ref) => ref.toLowerCase()))];
  return distinct.length === ONE_ACCOUNT ? matches[0] : '';
}
