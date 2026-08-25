// Weles credentials and trajectory account state live in Skarbiec. Stado owns
// action placement and queueing; this module never opens a database connection.
import {
  readOptionalWelesServiceLogin,
  readOptionalWelesServiceSecret,
  type WelesServiceSecret,
} from '../secrets/scoped-service.js';
import {
  enqueueAction,
  getAccount,
  listAccounts,
  listServiceMetadata,
  updateAccount,
} from '../state/skarbiec-records.js';

interface ServiceCredential {
  display_name: string;
  category: string;
  proxy_host: string | null;
  proxy_port: string | null;
  api_key_env_var: string | null;
  balance_usd: number | null;
  notes: string | null;
}

export async function getByCategory(category: string): Promise<ServiceCredential[]> {
  return listServiceMetadata(category).map((record) => ({
    display_name: String(record.display_name ?? record.id),
    category: String(record.category ?? ''),
    proxy_host: record.host ? String(record.host) : null,
    proxy_port: record.port ? String(record.port) : null,
    api_key_env_var: record.api_key_env_var ? String(record.api_key_env_var) : null,
    balance_usd: typeof record.balance_usd === 'number' ? record.balance_usd : null,
    notes: record.notes ? String(record.notes) : null,
  }));
}

export async function getCaptchaCredentials(): Promise<{ anticaptcha?: string; twocaptcha?: string; capsolver?: string; capmonster?: string; nocaptcha?: string; nopecha?: string }> {
  const credentials = {
    anticaptcha: readOptionalWelesServiceSecret('antiCaptcha', 'api_key'),
    twocaptcha: readOptionalWelesServiceSecret('twoCaptcha', 'api_key'),
    capsolver: readOptionalWelesServiceSecret('capsolver', 'api_key'),
    capmonster: readOptionalWelesServiceSecret('capmonster', 'api_key'),
    nocaptcha: readOptionalWelesServiceSecret('noCaptcha', 'api_key'),
    nopecha: readOptionalWelesServiceSecret('nopecha', 'api_key'),
  };
  console.log(`[credentials] Captcha services: ${Object.entries(credentials).filter(([, value]) => value).map(([name]) => name).join(', ') || 'none'}`);
  return credentials;
}

export async function getEmailApiKey(): Promise<string | undefined> {
  return readOptionalWelesServiceSecret('resendReceiving', 'api_key');
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

export async function getSocialAccount(platform: string): Promise<SocialAccount | null> {
  const requested = process.env.WELES_LOGIN_ITEM || process.env.ACCOUNT_ITEM || '';
  const candidates = requested
    ? [getAccount(requested)].filter(Boolean)
    : listAccounts(platform);
  const accounts = candidates.filter((account) => account?.platform === platform);
  if (!accounts.length) return null;
  const cutoffMs = Date.now() - 24 * 3600 * 1000;
  const fresh = accounts.find((account) => {
    const staleMs = Date.parse(String(account?.metadata.cookies_stale_at ?? ''));
    const mintMs = Date.parse(String(account?.metadata.cookies_minted_at ?? ''));
    return !Number.isFinite(staleMs)
      || staleMs < cutoffMs
      || (Number.isFinite(mintMs) && mintMs >= staleMs);
  }) ?? accounts[0];
  if (!fresh) return null;
  return {
    id: fresh.id,
    platform: fresh.platform,
    username: fresh.username,
    metadata: { ...fresh.metadata, password: fresh.password },
  };
}

/** Mark cookies stale and submit the corresponding login action to Stado. */
export async function markCookiesStale(accountId: string): Promise<void> {
  const account = getAccount(accountId);
  if (!account) return;
  updateAccount(accountId, { metadata: { cookies_stale_at: new Date().toISOString() } });
  if (account.platform.toLowerCase() === 'apple') {
    console.warn('[credentials] OWNER_ACTION_REQUIRED: Apple cookies are stale; apple_login was not submitted');
    return;
  }
  enqueueAction(`${account.platform}_login`, account.id, {
    reason: 'auto-recovery from cookies-stale',
  });
}

type ServiceLoginContract = {
  service: WelesServiceSecret;
  loginMethod: 'email_password' | 'google_sso';
};

const SERVICE_LOGIN_CONTRACTS: Readonly<Record<string, ServiceLoginContract>> = Object.freeze({
  'bright data': { service: 'brightdataDashboard', loginMethod: 'google_sso' },
  umami: { service: 'umamiDashboard', loginMethod: 'email_password' },
  'google analytics': { service: 'googleSso', loginMethod: 'google_sso' },
  // display_name 'Claude' is the vault's claude-wisent-google-sso account (see
  // LOGIN_ACCOUNTS in ./login-accounts.ts). Its login is read from that item
  // directly: the credential store holds no row for it, and copying the secret
  // into one would create a second source of truth for the same password.
  claude: { service: 'claudeWisentGoogleSso', loginMethod: 'google_sso' },
  // The pool row carries the account in its name, and its credentials live in
  // their own vault item rather than the shared Google SSO one.
  claude_controlyourai: { service: 'claudeControlYourAi', loginMethod: 'google_sso' },
  codex: { service: 'googleSso', loginMethod: 'google_sso' },
  codex_lukasz_gmail: { service: 'codexLukaszGmail', loginMethod: 'google_sso' },
  codex_controlyourai: { service: 'codexControlYourAi', loginMethod: 'google_sso' },
  codex_bartlomiej_wisent: { service: 'codexBartlomiejWisent', loginMethod: 'google_sso' },
  codex_jakub_wisent: { service: 'codexJakubWisent', loginMethod: 'google_sso' },
  codex_zuzanna_gmail: { service: 'codexZuzannaGmail', loginMethod: 'google_sso' },
  codex_lukasz_wisent_com: { service: 'codexLukaszWisentCom', loginMethod: 'google_sso' },
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
export async function getServiceLogin(displayName: string): Promise<{ email: string; password: string; loginMethod: string; totpSecret?: string } | null> {
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

const PLATFORM_ADMIN_LOGIN_CONTRACTS: Readonly<Record<string, WelesServiceSecret>> = Object.freeze({
  'platform-admin-google': 'googleWorkspaceAdmin',
  'platform-admin-linear': 'linearDashboard',
  'platform-admin-sso': 'googleWorkspaceAdmin',
});

// Readiness is based only on an exact item+consumer+field grant. Unknown
// platform IDs fail closed instead of probing plaintext Weles DB columns.
export async function platformAdminSessionReady(credentialId: string): Promise<{ ready: boolean; source: string }> {
  const service = PLATFORM_ADMIN_LOGIN_CONTRACTS[credentialId];
  if (!service) return { ready: false, source: 'no_exact_skarbiec_contract' };
  try {
    const login = readOptionalWelesServiceLogin(service);
    return login
      ? { ready: true, source: `skarbiec:${service}` }
      : { ready: false, source: `skarbiec_grant_unavailable:${service}` };
  } catch {
    return { ready: false, source: `skarbiec_error:${service}` };
  }
}

export type { ServiceCredential };

// resolveAccountSession + AccountSession moved to src/account/session.ts on
// 2026-05-03 (file-size cap). Re-exported here so callers using the legacy
// `import { resolveAccountSession } from '../utils/credentials.js'` still work.
export { resolveAccountSession } from '../account/session.js';
export type { AccountSession } from '../account/session.js';
