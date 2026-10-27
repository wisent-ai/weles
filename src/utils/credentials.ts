// Weles credentials and trajectory account state live in Skarbiec; follow-up
// actions start as detached runs of the Weles API. This module never opens a
// database connection.
import {
  readOptionalWelesServiceLogin,
  readOptionalWelesServiceSecret,
  type WelesServiceSecret,
} from '../secrets/scoped-service.js';
import {
  getAccount,
  listAccounts,
  listServiceMetadata,
  updateAccount,
} from '../state/skarbiec-records.js';
import { submitWelesRun } from '../worker/run-submit/index.js';

interface ServiceCredential {
  display_name: string;
  category: string;
  proxy_host: string | null;
  proxy_port: string | null;
  api_key_env_var: string | null;
  balance_usd: number | null;
  notes: string | null;
}

export async function getByCategory(
  category: string,
): Promise<ServiceCredential[]> {
  // listServiceMetadata answers only the records filed under `category`.
  return listServiceMetadata(category).map((record) => ({
    display_name: record.display_name ? String(record.display_name) : String(record.id),
    category,
    proxy_host: record.host ? String(record.host) : null,
    proxy_port: record.port ? String(record.port) : null,
    api_key_env_var: record.api_key_env_var
      ? String(record.api_key_env_var)
      : null,
    balance_usd:
      typeof record.balance_usd === 'number' ? record.balance_usd : null,
    notes: record.notes ? String(record.notes) : null,
  }));
}

export async function getCaptchaCredentials(): Promise<{
  anticaptcha?: string;
  twocaptcha?: string;
  capsolver?: string;
  capmonster?: string;
  nocaptcha?: string;
  nopecha?: string;
  solvecha?: string;
}> {
  const credentials = {
    anticaptcha: readOptionalWelesServiceSecret('antiCaptcha', 'api_key'),
    twocaptcha: readOptionalWelesServiceSecret('twoCaptcha', 'api_key'),
    capsolver: readOptionalWelesServiceSecret('capsolver', 'api_key'),
    capmonster: readOptionalWelesServiceSecret('capmonster', 'api_key'),
    nocaptcha: readOptionalWelesServiceSecret('noCaptcha', 'api_key'),
    nopecha: readOptionalWelesServiceSecret('nopecha', 'api_key'),
    solvecha: readOptionalWelesServiceSecret('solvecha', 'api_key'),
  };
  const configured = Object.entries(credentials)
    .filter(([, value]) => value)
    .map(([name]) => name);
  console.log(
    `[credentials] Captcha services: ${configured.length ? configured.join(', ') : 'none configured'}`,
  );
  return credentials;
}

export interface SocialAccount {
  id?: string;
  platform: string;
  username: string;
  metadata: {
    email?: string;
    password?: string;
    skarbiec_credential_id?: string;
    cookies?: unknown[];
    status?: string;
    proxy?: unknown;
    [key: string]: unknown;
  };
}

export async function getSocialAccount(
  platform: string,
): Promise<SocialAccount | null> {
  const [requested, ...otherBindings] = [
    process.env.WELES_LOGIN_ITEM,
    process.env.ACCOUNT_ITEM,
    process.env.ACCOUNT_ID,
  ].filter((item): item is string => Boolean(item));
  if (otherBindings.some((item) => item !== requested))
    throw new Error(
      `conflicting Weles account bindings: ${[requested, ...otherBindings].join(', ')}; the run cannot choose an account`,
    );
  const candidates = requested
    ? [getAccount(requested)].filter(Boolean)
    : listAccounts(platform);
  const accounts = candidates.filter(
    (account) => account?.platform === platform,
  );
  const [first] = accounts;
  if (!first) return null;
  // An account is fresh when nothing marked its cookies stale, or a verified
  // login minted cookies after the mark. A stale mark is lifted by that login,
  // not by a day passing. With no fresh account, the first is still answered:
  // its stored login is what refreshes the cookies.
  const fresh = accounts.find((account) => {
    const staleMs = instant(account?.metadata.cookies_stale_at);
    const mintMs = instant(account?.metadata.cookies_minted_at);
    return (
      !Number.isFinite(staleMs) ||
      (Number.isFinite(mintMs) && mintMs >= staleMs)
    );
  });
  let chosen = first;
  if (fresh) chosen = fresh;
  if (!chosen) return null;
  return {
    id: chosen.id,
    platform: chosen.platform,
    username: chosen.username,
    metadata: { ...chosen.metadata, password: chosen.password },
  };
}

/** The instant a metadata timestamp names; NaN when it names none. */
function instant(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  return Date.parse(value);
}

/**
 * Mark cookies stale and start the corresponding login action as a detached
 * Weles run. Its callers end their run right after and drop what it throws,
 * so an account that cannot be marked or re-logged is said here, by account
 * and cause, before the error is raised.
 */
export async function markCookiesStale(accountId: string): Promise<void> {
  try {
    await markAndRelogin(accountId);
  } catch (error) {
    console.error(
      `[credentials] cookies of ${accountId} are stale but no re-login was started: ${error}`,
    );
    throw error;
  }
}

async function markAndRelogin(accountId: string): Promise<void> {
  const account = getAccount(accountId);
  if (!account)
    throw new Error(`no account ${accountId} in the Weles account store`);
  updateAccount(accountId, {
    metadata: { cookies_stale_at: new Date().toISOString() },
  });
  if (account.platform.toLowerCase() === 'apple') {
    console.warn(
      '[credentials] OWNER_ACTION_REQUIRED: Apple cookies are stale; apple_login was not submitted',
    );
    return;
  }
  const runId = await submitWelesRun({
    action: `${account.platform}_login`,
    accountItem: account.id,
    params: { reason: 'auto-recovery from cookies-stale' },
  });
  console.log(
    `[credentials] cookies stale on ${account.id}: ${account.platform}_login started as run ${runId}`,
  );
}

type ServiceLoginContract = {
  service: WelesServiceSecret;
  loginMethod: 'email_password' | 'google_sso';
};

const SERVICE_LOGIN_CONTRACTS: Readonly<Record<string, ServiceLoginContract>> =
  Object.freeze({
    'bright data': {
      service: 'brightdataDashboard',
      loginMethod: 'google_sso',
    },
    umami: { service: 'umamiDashboard', loginMethod: 'email_password' },
    'google analytics': { service: 'googleSso', loginMethod: 'google_sso' },
    linear: { service: 'linearDashboard', loginMethod: 'email_password' },
    oxylabs: { service: 'oxylabsDashboard', loginMethod: 'google_sso' },
    vast: { service: 'vastDashboard', loginMethod: 'email_password' },
    'vast.ai': { service: 'vastDashboard', loginMethod: 'email_password' },
  });

/**
 * Get service login material for balance checks. Email, password and the
 * Google TOTP seed come from the exact scoped Skarbiec grant for the service,
 * never from plaintext Weles DB columns.
 */
export async function getServiceLogin(displayName: string): Promise<{
  email: string;
  password: string;
  loginMethod: string;
  totpSecret?: string;
} | null> {
  const contract = SERVICE_LOGIN_CONTRACTS[displayName.trim().toLowerCase()];
  if (!contract) return null;
  const login = readOptionalWelesServiceLogin(contract.service);
  if (!login) return null;
  return {
    email: login.email,
    password: login.password,
    loginMethod: contract.loginMethod,
    ...(login.totpSecret ? { totpSecret: login.totpSecret } : {}),
  };
}

const PLATFORM_ADMIN_LOGIN_CONTRACTS: Readonly<
  Record<string, WelesServiceSecret>
> = Object.freeze({
  'platform-admin-google': 'googleWorkspaceAdmin',
  'platform-admin-linear': 'linearDashboard',
  'platform-admin-sso': 'googleWorkspaceAdmin',
});

// Readiness is based only on an exact item+consumer+field grant. Unknown
// platform IDs fail closed instead of probing plaintext Weles DB columns.
export async function platformAdminSessionReady(
  credentialId: string,
): Promise<{ ready: boolean; source: string }> {
  const service = PLATFORM_ADMIN_LOGIN_CONTRACTS[credentialId];
  if (!service) return { ready: false, source: 'no_exact_skarbiec_contract' };
  try {
    const login = readOptionalWelesServiceLogin(service);
    return login
      ? { ready: true, source: `skarbiec:${service}` }
      : { ready: false, source: `skarbiec_grant_unavailable:${service}` };
  } catch (error) {
    // The cause is part of the answer: "skarbiec_error" alone does not say
    // whether the vault was locked, unreachable or refused the grant.
    return vaultUnreadable(service, error);
  }
}

/** The readiness answer of a platform admin whose grant could not be read, naming the vault's error. */
function vaultUnreadable(service: string, error: unknown): { ready: boolean; source: string } {
  return {
    ready: false,
    source: `skarbiec_error:${service}: ${error instanceof Error ? error.message : String(error)}`,
  };
}

export type { ServiceCredential };

// resolveAccountSession + AccountSession live in src/account/session.ts
// (file-size cap). Re-exported here so callers using the legacy
// `import { resolveAccountSession } from '../utils/credentials.js'` still work.
export { resolveAccountSession } from '../account/session.js';
export type { AccountSession } from '../account/session.js';
