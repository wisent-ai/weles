// The two vault items an acquired account lives in: its login row, which says
// how Weles signs it in, and the subscription item Brama routes over, which
// names the account and the login row and later holds the grant.
//
// Both are written before the account is signed in, so a sign-in that fails
// after the purchase leaves an account Brama lists and can sign in again,
// never a paid account nothing records.

import {
  listCredentialItems,
  readDocument,
  writeTaggedDocument,
} from '../../state/skarbiec-records.js';
import { slug } from './identity.js';

export interface AcquiredAccount {
  /** Correlation identity for the purchase, not the permanent pool member. */
  requestId: string;
  /** The provider's Weles name (`claude`). */
  provider: string;
  /** Brama's provider name (`claude-code`). */
  bramaProvider: string;
  /** The address the account signs in with. */
  email: string;
  /** The plan the account was bought on, as the provider names its tier. */
  planTier: string;
}

function itemIdFor(prefix: string, subscriptionId: string): string {
  return `${prefix}-${subscriptionId}`;
}

/** Write the login row and the subscription item; answer their ids. */
export function bankAcquiredAccount(account: AcquiredAccount): {
  loginItem: string;
  subscriptionItem: string;
  subscriptionId: string;
} {
  const subscriptionId = `${slug(account.bramaProvider)}-${slug(account.email)}`;
  const loginItem = itemIdFor('weles-login', subscriptionId);
  const subscriptionItem = itemIdFor('brama-sub', subscriptionId);
  const existing = new Set(
    listCredentialItems().map((row) => String(row.id ?? row.name)),
  );
  for (const id of [loginItem, subscriptionItem])
    if (existing.has(id))
      throw new Error(
        `vault item ${id} already exists; acquisition cannot overwrite the account ${account.email}`,
      );
  const acquiredAt = new Date().toISOString();
  writeTaggedDocument(
    loginItem,
    'login',
    {
      schema: 'skarbiec.item.v2',
      kind: 'login',
      fields: { username: account.email },
      context: {
        provider: account.provider,
        login_method: 'email_code',
        account_ref: account.email,
        acquired_at: acquiredAt,
        acquisition_request: account.requestId,
      },
    },
    ['weles:login-method:email_code'],
  );
  writeTaggedDocument(
    subscriptionItem,
    'bundle',
    {
      schema: 'skarbiec.item.v2',
      kind: 'bundle',
      fields: {},
      context: {
        source_kind: 'acquisition',
        provider: account.bramaProvider,
        account_ref: account.email,
        login_item: loginItem,
        login_method: 'email_code',
        plan_tier: account.planTier,
        acquired_at: acquiredAt,
        acquisition_request: account.requestId,
      },
    },
    [
      'brama:subscription',
      `brama:provider:${account.bramaProvider}`,
      `brama:id:${subscriptionId}`,
      `brama:account:${account.email}`,
      `brama:login:${loginItem}`,
    ],
  );
  for (const id of [loginItem, subscriptionItem])
    if (!readDocument(id).context?.acquired_at)
      throw new Error(
        `Skarbiec did not return vault item ${id} just written for subscription ${subscriptionId}`,
      );
  return { loginItem, subscriptionItem, subscriptionId };
}
