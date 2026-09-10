import { randomInt } from 'node:crypto';
import { GENERATED_PASSWORD_LENGTH, MICROSOFT_PASSWORD_ID, PASSWORD_FIELD } from './constants.mjs';

/** The exact Skarbiec contract this run carries, or a refusal when any field is off. */
export function constraints(expectedOperation) {
  let parsed;
  try {
    parsed = JSON.parse(process.env.WELES_CREDENTIAL_CONSTRAINTS ?? '{}');
  } catch {
    throw new Error('invalid Weles credential constraints');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid Weles credential constraints');
  }
  const credentialId = typeof parsed.secret === 'string' ? parsed.secret : '';
  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : '';
  const operation = typeof parsed.operation === 'string' ? parsed.operation : '';
  const accountEmail = typeof parsed.account_email === 'string' ? parsed.account_email.trim().toLowerCase() : '';
  const tenantId = typeof parsed.tenant_id === 'string' ? parsed.tenant_id : null;
  if (!MICROSOFT_PASSWORD_ID.test(credentialId)
      || operation !== expectedOperation
      || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)
      || parsed.vault_item_id !== credentialId
      || parsed.vault_field !== PASSWORD_FIELD
      || !/^[a-f0-9]{64}$/i.test(requestId)
      || parsed.provider !== 'microsoft') {
    throw new Error('Microsoft password operation is outside its exact Skarbiec contract');
  }
  return { credentialId, operation, accountEmail, tenantId, requestId };
}

export function accountEmail(account) {
  return String(account.metadata?.email ?? account.username ?? '').trim().toLowerCase();
}

/** Whether the queued account is the one the contract names, credential reference included. */
export function accountMatchesContract(account, contract) {
  const metadata = account?.metadata ?? {};
  return accountEmail(account) === contract.accountEmail
    && metadata.skarbiec_credential_id === contract.credentialId
    && (metadata.skarbiec_tenant_id ?? null) === (contract.tenantId ?? null);
}

/** A fresh password with at least one character from every group, shuffled. */
export function generatedPassword() {
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!#$%&()*+,-.:;<=>?@[]^_{|}~',
  ];
  const all = groups.join('');
  const chars = groups.map((group) => group[randomInt(group.length)]);
  while (chars.length < GENERATED_PASSWORD_LENGTH) chars.push(all[randomInt(all.length)]);
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [chars[index], chars[target]] = [chars[target], chars[index]];
  }
  return chars.join('');
}
