// Which stored account, if any, is allowed to own this managed password.
//
// A password operation runs against a live account session, so getting this
// wrong means changing the password of an account nobody asked about. Both
// readers therefore insist on exactly one active match and on a binding that
// already points both ways: the account must name this credential item, and no
// other account in the same scope may name it. Ambiguity is never resolved by
// picking a row — it is returned as the reason nothing was queued, and so is
// the absence of any match.
//
// The two readers stay separate because they identify an account by different
// evidence. A consumer account is found by the email a human types, while a
// directory identity is only accepted when the record repeats the UPN, the
// tenant and the principal object id the caller claimed, each checked on its own
// so the sentence says which one is absent.
//
// The error strings are the words the caller sees in `missing`, so each one
// names the single repair that unblocks it.

import { listAccounts } from '../../../state/skarbiec-records.js';

type MicrosoftAccountRow = {
  id: string;
  username: string;
  active: boolean;
  metadata?: {
    email?: string;
    skarbiec_credential_id?: string;
    skarbiec_tenant_id?: string;
  };
};

type Binding = { accountId: string | null; error?: string };

/** Whether `row` belongs to the Skarbiec tenant scope `tenant`: a row that
 *  records no tenant (absent or JSON null) is in the unscoped vault, and only
 *  an unscoped request reaches it. */
function inScope(row: MicrosoftAccountRow, tenant: string | null | undefined): boolean {
  const recorded: string | null | undefined = row.metadata?.skarbiec_tenant_id;
  const unscoped = (value: string | null | undefined) =>
    value === null || value === undefined;
  if (unscoped(tenant)) return unscoped(recorded);
  return recorded === tenant;
}

/** Whether the row's username or recorded email is `wanted`, case aside. */
function named(row: MicrosoftAccountRow, wanted: string): boolean {
  return (
    row.username.trim().toLowerCase() === wanted ||
    row.metadata?.email?.trim().toLowerCase() === wanted
  );
}

export function microsoftAccountBinding(
  accountEmail: string,
  credentialId: string,
  tenantId?: string | null,
): Binding {
  const rows = listAccounts('microsoft') as MicrosoftAccountRow[];
  const normalized = accountEmail.trim().toLowerCase();
  const tenantRows = rows.filter((row) => inScope(row, tenantId));
  const matches = tenantRows.filter((row) => row.active && named(row, normalized));
  const [account, another] = matches;
  if (another)
    return {
      accountId: null,
      error: `${matches.length} active Microsoft accounts claim ${normalized}; exactly one may own the managed password`,
    };
  if (!account)
    return {
      accountId: null,
      error: `no active Microsoft account in this scope has the username or email ${normalized}`,
    };
  const otherOwner = tenantRows.find(
    (row) =>
      row.id !== account.id &&
      row.metadata?.skarbiec_credential_id === credentialId,
  );
  if (otherOwner)
    return {
      accountId: null,
      error: 'credential item is already bound to another Microsoft account',
    };
  const boundCredential = account.metadata?.skarbiec_credential_id;
  if (boundCredential && boundCredential !== credentialId) {
    return {
      accountId: null,
      error: 'Microsoft account is already bound to another credential item',
    };
  }
  if (boundCredential !== credentialId) {
    return {
      accountId: null,
      error:
        'Microsoft account is not bound to the requested managed credential',
    };
  }
  return { accountId: account.id };
}

type EntraAccountRow = MicrosoftAccountRow & {
  metadata?: MicrosoftAccountRow['metadata'] & {
    entra_upn?: string;
    entra_tenant_id?: string;
    entra_principal_object_id?: string;
  };
};

export function entraAccountBinding(
  accountUpn: string,
  credentialId: string,
  tenantId: string,
  principalObjectId: string,
  skarbiecTenantId: string | null,
): Binding {
  const rows = listAccounts('microsoft') as EntraAccountRow[];
  const scoped = rows.filter((row) => inScope(row, skarbiecTenantId));
  const claiming = scoped.filter(
    (row) =>
      row.active &&
      (row.metadata?.entra_upn?.trim().toLowerCase() === accountUpn ||
        named(row, accountUpn)),
  );
  const [account, another] = claiming;
  if (another)
    return {
      accountId: null,
      error: `${claiming.length} active accounts claim the requested Entra UPN ${accountUpn}; exactly one may own the managed password`,
    };
  if (!account)
    return {
      accountId: null,
      error: `no active account in this scope has the Entra UPN, username or email ${accountUpn}`,
    };
  const metadata = account.metadata;
  if (metadata?.entra_upn?.trim().toLowerCase() !== accountUpn) {
    return {
      accountId: null,
      error: `account record is missing metadata entra_upn ${accountUpn}`,
    };
  }
  if (metadata.entra_tenant_id?.trim().toLowerCase() !== tenantId) {
    return {
      accountId: null,
      error: `account record is missing metadata entra_tenant_id ${tenantId}`,
    };
  }
  if (
    metadata.entra_principal_object_id?.trim().toLowerCase() !==
    principalObjectId
  ) {
    return {
      accountId: null,
      error: `account record is missing metadata entra_principal_object_id ${principalObjectId}`,
    };
  }
  const otherOwner = scoped.find(
    (row) =>
      row.id !== account.id &&
      row.metadata?.skarbiec_credential_id === credentialId,
  );
  if (otherOwner)
    return {
      accountId: null,
      error: 'credential item is already bound to another Entra account',
    };
  const boundCredential = metadata.skarbiec_credential_id;
  if (boundCredential && boundCredential !== credentialId) {
    return {
      accountId: null,
      error: 'Entra account is already bound to another credential item',
    };
  }
  if (boundCredential !== credentialId) {
    return {
      accountId: null,
      error: 'Entra account is not bound to the requested managed credential',
    };
  }
  return { accountId: account.id };
}
