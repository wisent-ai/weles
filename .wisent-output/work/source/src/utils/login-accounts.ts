// Which subscription account a login or reauth run is for.
//
// The fleet identifies an account by its vault login item id — the same string
// Brama carries as the `brama:login:<id>` tag on a subscription bundle — while
// Weles selects an account by the display name of its service_credentials row,
// which in turn resolves the scoped vault contract holding that account's
// secrets (SERVICE_LOGIN_CONTRACTS in ./credentials.ts). Those names are the
// same fact in two namespaces, so the correspondence is stated once here.
//
// Without this table a caller cannot ask for an account at all: reauth took the
// least-recently-updated row matching the provider, so an automatic renewal loop
// asking to renew one named subscription had no way to say which one, and
// guessing signs into the wrong Google account and mints a credential for the
// wrong subscription.

export type LoginAccountProvider = 'claude' | 'codex' | 'kimi';

export interface LoginAccount {
  /** Vault login item id; the identifier the rest of the fleet uses. */
  loginItem: string;
  provider: LoginAccountProvider;
  /** service_credentials.display_name of this account's row. */
  displayName: string;
}

export const LOGIN_ACCOUNTS: readonly LoginAccount[] = Object.freeze([
  Object.freeze({ loginItem: 'claude-wisent-google-sso', provider: 'claude', displayName: 'Claude' }),
  // This pool row has its own vault item rather than the shared Google SSO one,
  // which is why account identity must travel with the request instead of being
  // derived from the provider.
  Object.freeze({ loginItem: 'claude_controlyourai', provider: 'claude', displayName: 'Claude_controlyourai' }),
  Object.freeze({ loginItem: 'codex-wisent-google-sso', provider: 'codex', displayName: 'Codex' }),
  Object.freeze({ loginItem: 'codex-lukasz-google-sso', provider: 'codex', displayName: 'Codex_lukasz_gmail' }),
  Object.freeze({ loginItem: 'codex-controlyourai-google-sso', provider: 'codex', displayName: 'Codex_controlyourai' }),
  Object.freeze({ loginItem: 'codex-bartlomiej-wisent-google-sso', provider: 'codex', displayName: 'Codex_bartlomiej_wisent' }),
  Object.freeze({ loginItem: 'codex-jakub-wisent-google-sso', provider: 'codex', displayName: 'Codex_jakub_wisent' }),
  Object.freeze({ loginItem: 'codex-zuzanna-google-sso', provider: 'codex', displayName: 'Codex_zuzanna_gmail' }),
  Object.freeze({ loginItem: 'codex-lukasz-wisent-com-google-sso', provider: 'codex', displayName: 'Codex_lukasz_wisent_com' }),
  Object.freeze({ loginItem: 'kimi-lukasz-google-sso', provider: 'kimi', displayName: 'Kimi' }),
] as const);

export type LoginAccountSelectionCode =
  | 'unknown_login_item'
  | 'login_item_provider_mismatch'
  | 'ambiguous_account_selection'
  | 'account_not_found'
  | 'no_candidate_rows';

// Carries the machine-readable code and the payload an HTTP caller gets, so the
// API surface and a trajectory's stderr say the same thing about the same refusal.
export class LoginAccountSelectionError extends Error {
  readonly code: LoginAccountSelectionCode;

  readonly detail: Record<string, unknown>;

  constructor(code: LoginAccountSelectionCode, message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = 'LoginAccountSelectionError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Resolve the account a run is for.
 *
 * `loginItem` present: exactly that account, and it must belong to `provider`.
 * `loginItem` absent: the provider's only account, or a refusal naming every
 * candidate — a run that cannot tell which account it is for must not pick one.
 */
export function selectLoginAccount(provider: string, loginItem?: string | null): LoginAccount {
  const wanted = typeof loginItem === 'string' ? loginItem.trim() : '';
  if (wanted) {
    const account = LOGIN_ACCOUNTS.find((a) => a.loginItem === wanted);
    if (!account) {
      const known = LOGIN_ACCOUNTS.map((a) => a.loginItem);
      throw new LoginAccountSelectionError(
        'unknown_login_item',
        `unknown_login_item: ${wanted} is not a known vault login item (known: ${known.join(', ')})`,
        { login_item: wanted, known },
      );
    }
    if (account.provider !== provider) {
      throw new LoginAccountSelectionError(
        'login_item_provider_mismatch',
        `login_item_provider_mismatch: ${wanted} belongs to ${account.provider}, not ${provider}`,
        { login_item: wanted, provider, item_provider: account.provider },
      );
    }
    return account;
  }
  const candidates = LOGIN_ACCOUNTS.filter((a) => a.provider === provider);
  if (candidates.length === 1) return candidates[0];
  throw new LoginAccountSelectionError(
    'ambiguous_account_selection',
    candidates.length === 0
      ? `ambiguous_account_selection: no account is registered for provider ${provider}`
      : `ambiguous_account_selection: ${provider} has ${candidates.length} accounts `
        + `(${candidates.map((a) => a.loginItem).join(', ')}); pass login_item`,
    {
      provider,
      candidates: candidates.map((a) => a.loginItem),
      display_names: candidates.map((a) => a.displayName),
      hint: 'pass login_item',
    },
  );
}

export interface CredentialRowLike {
  display_name?: string | null;
}

/**
 * Pick the credential row a run must sign in, out of the candidate rows the
 * credential store returned for one provider.
 *
 * `displayName` present (the caller named the account, directly or through its
 * vault login item): exactly the row carrying that name, or a refusal listing
 * the rows that do exist. Absent: the only candidate, or a refusal naming them
 * all — with several rows, taking one signs into a different Google account and
 * mints a credential for a different subscription, which is worse than stopping.
 */
export function chooseCredentialRow<T extends CredentialRowLike>(
  rows: readonly T[],
  selector: { provider: string; displayName?: string | null; loginItem?: string | null },
): T {
  const present = rows.map((r) => (r.display_name ?? '').trim()).filter(Boolean);
  if (!rows.length) {
    throw new LoginAccountSelectionError(
      'no_candidate_rows',
      `no_candidate_rows: the credential store holds no login row for provider ${selector.provider}`,
      { provider: selector.provider },
    );
  }
  const wanted = (selector.displayName ?? '').trim();
  if (wanted) {
    const named = rows.find((r) => (r.display_name ?? '').trim().toLowerCase() === wanted.toLowerCase());
    if (!named && LOGIN_ACCOUNTS.some((a) => a.displayName.toLowerCase() === wanted.toLowerCase())) {
      // The account is one this build knows and its login lives in the vault, so
      // the absence of a store row is not the absence of an account: the store row
      // only carries metadata, and inventing one would add a second registry of
      // accounts without adding a single fact. The caller gets a row that names
      // the account and no id, and callers that record attempts skip it.
      return { display_name: wanted } as T;
    }
    if (!named) {
      throw new LoginAccountSelectionError(
        'account_not_found',
        `account_not_found: no ${selector.provider} login row named '${wanted}'`
        + `${selector.loginItem ? ` (login item ${selector.loginItem})` : ''}`
        + `; rows present: ${present.join(', ')}`,
        { provider: selector.provider, display_name: wanted, login_item: selector.loginItem ?? null, rows_present: present },
      );
    }
    return named;
  }
  if (rows.length > 1) {
    throw new LoginAccountSelectionError(
      'ambiguous_account_selection',
      `ambiguous_account_selection: ${rows.length} ${selector.provider} login rows could match `
      + `(${present.join(', ')}); pass login_item to name one`,
      { provider: selector.provider, candidates: present, hint: 'pass login_item' },
    );
  }
  return rows[0];
}
