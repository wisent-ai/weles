// Which stored account, if any, is allowed to own this managed password.
//
// A password operation runs against a live account session, so getting this
// wrong means changing the password of an account nobody asked about. Both
// readers therefore insist on exactly one active match and on a binding that
// already points both ways: the account must name this credential item, and no
// other account in the same scope may name it. Ambiguity is never resolved by
// picking a row — it is returned as the reason nothing was queued.
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
  metadata: { email?: string; skarbiec_credential_id?: string; skarbiec_tenant_id?: string };
};

export function microsoftAccountBinding(
  accountEmail: string,
  credentialId: string,
  tenantId?: string | null,
): { accountId: string | null; error?: string } {
  const rows = listAccounts('microsoft') as MicrosoftAccountRow[];
  const normalized = accountEmail.trim().toLowerCase();
  const requestedTenant = tenantId ?? null;
  const tenantRows = rows.filter((row) =>
    (row.metadata?.skarbiec_tenant_id ?? null) === requestedTenant);
  const matches = tenantRows.filter((row) => {
    const username = row.username.trim().toLowerCase();
    const email = row.metadata?.email?.trim().toLowerCase() ?? '';
    return row.active && (username === normalized || email === normalized);
  });
  const account = matches[0];
  if (matches.length !== 1 || !account) return { accountId: null };
  const otherOwner = tenantRows.find((row) => row.id !== account.id
    && row.metadata?.skarbiec_credential_id === credentialId);
  if (otherOwner) return { accountId: null, error: 'credential item is already bound to another Microsoft account' };
  const boundCredential = account.metadata?.skarbiec_credential_id;
  if (boundCredential && boundCredential !== credentialId) {
    return { accountId: null, error: 'Microsoft account is already bound to another credential item' };
  }
  if (boundCredential !== credentialId) {
    return { accountId: null, error: 'Microsoft account is not bound to the requested managed credential' };
  }
  return { accountId: account.id };
}

type EntraAccountRow = MicrosoftAccountRow & {
  metadata: MicrosoftAccountRow['metadata'] & {
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
): { accountId: string | null; error?: string } {
  const rows = listAccounts('microsoft') as EntraAccountRow[];
  const scoped = rows.filter((row) => (row.metadata?.skarbiec_tenant_id ?? null) === skarbiecTenantId);
  const named = scoped.filter((row) => {
    const upn = row.metadata?.entra_upn?.trim().toLowerCase() ?? '';
    const email = row.metadata?.email?.trim().toLowerCase() ?? row.username.trim().toLowerCase();
    return row.active && (upn === accountUpn || email === accountUpn);
  });
  if (named.length > 1) return { accountId: null, error: 'more than one active account claims the requested Entra UPN' };
  const account = named[0];
  if (!account) return { accountId: null };
  const metadata = account.metadata ?? {};
  if (metadata.entra_upn?.trim().toLowerCase() !== accountUpn) {
    return { accountId: null, error: `account record is missing metadata entra_upn ${accountUpn}` };
  }
  if (metadata.entra_tenant_id?.trim().toLowerCase() !== tenantId) {
    return { accountId: null, error: `account record is missing metadata entra_tenant_id ${tenantId}` };
  }
  if (metadata.entra_principal_object_id?.trim().toLowerCase() !== principalObjectId) {
    return { accountId: null, error: `account record is missing metadata entra_principal_object_id ${principalObjectId}` };
  }
  const otherOwner = scoped.find((row) => row.id !== account.id
    && row.metadata?.skarbiec_credential_id === credentialId);
  if (otherOwner) return { accountId: null, error: 'credential item is already bound to another Entra account' };
  const boundCredential = metadata.skarbiec_credential_id;
  if (boundCredential && boundCredential !== credentialId) {
    return { accountId: null, error: 'Entra account is already bound to another credential item' };
  }
  if (boundCredential !== credentialId) {
    return { accountId: null, error: 'Entra account is not bound to the requested managed credential' };
  }
  return { accountId: account.id };
}
