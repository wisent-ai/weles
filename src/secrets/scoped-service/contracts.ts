// Credential schemas shared by the scoped reader and writer.
const API_KEY_FIELD = Object.freeze({ api_key: true });
const LOGIN_FIELDS = Object.freeze({ username: true, password: true });
const LOGIN_WITH_TOTP_FIELDS = Object.freeze({ username: true, password: true, totp_secret: true });
const ENDPOINT_PROXY_FIELDS = Object.freeze({ username: true, password: true, host: true, ports: true });
const BASIC_PROXY_FIELDS = Object.freeze({ username: true, password: true });
const BRIGHTDATA_PROXY_FIELDS = Object.freeze({ username: true, password: true, zone: true });
export const SERVICE_CONTRACTS = Object.freeze({
  googleSso: Object.freeze({ consumer: 'weles-google-sso-client', item: 'weles-google-sso-login', fields: LOGIN_FIELDS }),
  // The Claude Max pool row in the database is `Claude_controlyourai` and it has
  // its own vault item, so it must not borrow the shared googleSso login: that
  // would sign into a different Google account and mint a credential for the
  // wrong subscription.
  // This item currently declares username and password only. Asking Skarbiec
  // for an undeclared TOTP field makes the whole login fail before Chromium
  // starts, so the executable contract must match the item rather than carry a
  // field that might be added later.
  claudeControlYourAi: Object.freeze({ consumer: 'weles-claude-controlyourai-client', item: 'claude_controlyourai', fields: LOGIN_FIELDS }),
  // The account the fleet names claude-wisent-google-sso: the three live claude
  // subscriptions were minted by it, and its login lives in its own vault item.
  // Same optional-seed shape as the item above: a live sign-in for this account
  // reached Google's second-factor prompt on 2026-08-17 and stopped there, so the
  // contract has to be able to carry a seed once the vault item holds one.
  claudeWisentGoogleSso: Object.freeze({ consumer: 'weles-claude-wisent-google-sso-client', item: 'claude-wisent-google-sso', fields: LOGIN_WITH_TOTP_FIELDS }),
  // Every ChatGPT Business seat has its own login contract. Sharing googleSso
  // here would make a named Codex reauth mint the currently selected Google
  // account's credential instead of the account the caller requested.
  codexLukaszGmail: Object.freeze({ consumer: 'weles-codex-lukasz-gmail-client', item: 'codex-lukasz-google-sso', fields: LOGIN_FIELDS }),
  codexControlYourAi: Object.freeze({ consumer: 'weles-codex-controlyourai-client', item: 'codex-controlyourai-google-sso', fields: LOGIN_FIELDS }),
  codexBartlomiejWisent: Object.freeze({ consumer: 'weles-codex-bartlomiej-wisent-client', item: 'codex-bartlomiej-wisent-google-sso', fields: LOGIN_FIELDS }),
  codexJakubWisent: Object.freeze({ consumer: 'weles-codex-jakub-wisent-client', item: 'codex-jakub-wisent-google-sso', fields: LOGIN_FIELDS }),
  codexZuzannaGmail: Object.freeze({ consumer: 'weles-codex-zuzanna-gmail-client', item: 'codex-zuzanna-google-sso', fields: LOGIN_FIELDS }),
  codexLukaszWisentCom: Object.freeze({ consumer: 'weles-codex-lukasz-wisent-com-client', item: 'codex-lukasz-wisent-com-google-sso', fields: LOGIN_FIELDS }),
  googleWorkspaceAdmin: Object.freeze({ consumer: 'weles-google-workspace-admin-client', item: 'weles-google-workspace-admin-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  brightdataDashboard: Object.freeze({ consumer: 'weles-brightdata-dashboard-client', item: 'weles-brightdata-dashboard-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  oxylabsDashboard: Object.freeze({ consumer: 'weles-oxylabs-dashboard-client', item: 'weles-oxylabs-dashboard-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  umamiDashboard: Object.freeze({ consumer: 'weles-umami-dashboard-client', item: 'weles-umami-dashboard-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  linearDashboard: Object.freeze({ consumer: 'weles-linear-dashboard-client', item: 'weles-linear-dashboard-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  vastDashboard: Object.freeze({ consumer: 'weles-vast-dashboard-client', item: 'weles-vast-dashboard-login', fields: LOGIN_FIELDS }),
  antiCaptcha: Object.freeze({ consumer: 'weles-anti-captcha-client', item: 'weles-anti-captcha-api', fields: API_KEY_FIELD }),
  twoCaptcha: Object.freeze({ consumer: 'weles-two-captcha-client', item: 'weles-two-captcha-api', fields: API_KEY_FIELD }),
  capsolver: Object.freeze({ consumer: 'weles-capsolver-client', item: 'weles-capsolver-api', fields: API_KEY_FIELD }),
  capmonster: Object.freeze({ consumer: 'weles-capmonster-client', item: 'weles-capmonster-api', fields: API_KEY_FIELD }),
  noCaptcha: Object.freeze({ consumer: 'weles-nocaptcha-client', item: 'weles-nocaptcha-api', fields: API_KEY_FIELD }),
  nopecha: Object.freeze({ consumer: 'weles-nopecha-client', item: 'weles-nopecha-api', fields: API_KEY_FIELD }),
  resendReceiving: Object.freeze({ consumer: 'weles-resend-receiving-client', item: 'weles-resend-receiving-api', fields: API_KEY_FIELD }),
  resendManagement: Object.freeze({ consumer: 'weles-resend-management-client', item: 'weles-resend-management-api', fields: API_KEY_FIELD }),
  namecheap: Object.freeze({ consumer: 'weles-namecheap-client', item: 'weles-namecheap-api', fields: Object.freeze({ api_key: true, api_user: true, username: true, client_ip: true }) }),
  juicySms: Object.freeze({ consumer: 'weles-juicysms-client', item: 'weles-juicysms-api', fields: API_KEY_FIELD }),
  oxylabsResidential: Object.freeze({ consumer: 'weles-oxylabs-residential-proxy-client', item: 'weles-oxylabs-residential-proxy', fields: BASIC_PROXY_FIELDS }),
  oxylabsMobile: Object.freeze({ consumer: 'weles-oxylabs-mobile-proxy-client', item: 'weles-oxylabs-mobile-proxy', fields: BASIC_PROXY_FIELDS }),
  brightdataProxy: Object.freeze({ consumer: 'weles-brightdata-proxy-client', item: 'weles-brightdata-proxy', fields: BRIGHTDATA_PROXY_FIELDS }),
  packetstreamProxy: Object.freeze({ consumer: 'weles-packetstream-proxy-client', item: 'weles-packetstream-proxy', fields: BASIC_PROXY_FIELDS }),
  iproyalProxy: Object.freeze({ consumer: 'weles-iproyal-proxy-client', item: 'weles-iproyal-proxy', fields: BASIC_PROXY_FIELDS }),
  iproyalMobileProxy: Object.freeze({ consumer: 'weles-iproyal-mobile-proxy-client', item: 'weles-iproyal-mobile-proxy', fields: BASIC_PROXY_FIELDS }),
  pingproxiesProxy: Object.freeze({ consumer: 'weles-pingproxies-proxy-client', item: 'weles-pingproxies-proxy', fields: BASIC_PROXY_FIELDS }),
  oxylabsIsp: Object.freeze({ consumer: 'weles-oxylabs-isp-proxy-client', item: 'weles-oxylabs-isp-proxy', fields: ENDPOINT_PROXY_FIELDS }),
  oxylabsDedicatedIsp: Object.freeze({ consumer: 'weles-oxylabs-dedicated-isp-proxy-client', item: 'weles-oxylabs-dedicated-isp-proxy', fields: ENDPOINT_PROXY_FIELDS }),
  decodoIsp: Object.freeze({ consumer: 'weles-decodo-isp-proxy-client', item: 'weles-decodo-isp-proxy', fields: ENDPOINT_PROXY_FIELDS }),
  smsActivate: Object.freeze({ consumer: 'weles-sms-activate-client', item: 'weles-sms-activate-api', fields: API_KEY_FIELD }),
} as const);

const ACQUIRED_SECRET_CONTRACTS = Object.freeze({
  'semantic_scholar.api_key': Object.freeze({
    item: 'weles-semantic-scholar-api',
    field: 'api_key',
    writerConsumer: 'weles-semantic-scholar-api-writer',
    writerTokenFile: 'weles-semantic-scholar-api-writer-skarbiec-token',
    sourceOrigin: 'https://www.semanticscholar.org',
    shape: 'semantic-scholar',
  }),
  'github.admin_org_token': Object.freeze({
    item: 'weles-github-admin-org-token',
    field: 'api_key',
    writerConsumer: 'weles-github-admin-org-token-writer',
    writerTokenFile: 'weles-github-admin-org-token-writer-skarbiec-token',
    sourceOrigin: 'https://github.com',
    shape: 'github',
  }),
  'figma.personal_access_token': Object.freeze({
    item: 'weles-figma-personal-access-token',
    field: 'api_key',
    writerConsumer: 'weles-figma-personal-access-token-writer',
    writerTokenFile: 'weles-figma-personal-access-token-writer-skarbiec-token',
    sourceOrigin: 'https://www.figma.com',
    shape: 'opaque-token',
  }),
  'snapchat.snap_kit_api_token': Object.freeze({
    item: 'weles-snapchat-snap-kit-api',
    field: 'api_key',
    writerConsumer: 'weles-snapchat-snap-kit-api-writer',
    writerTokenFile: 'weles-snapchat-snap-kit-api-writer-skarbiec-token',
    sourceOrigin: 'https://kit.snapchat.com',
    shape: 'opaque-token',
  }),
  // Managed Microsoft account passwords. Each item declares its own provider
  // surface here, because nothing in the id may be trusted to imply one: an item
  // id is a mutable human-chosen vault name, so a rename has to miss an explicit
  // declaration and fail visibly instead of silently inheriting another account's
  // password lifecycle. These three are reached by the item id itself, not by a
  // logical name like the entries above: every caller addresses a managed password
  // through `def.secret`, which acquire.ts sets to the credential id
  // (microsoftPasswordDefinition, entraPasswordDefinition).
  //
  // Consumer Microsoft account: adopt, rotate and verify run at account.live.com
  // (src/trajectories/microsoft/password_lifecycle.mjs).
  'weles-microsoft-primary-password': Object.freeze({
    item: 'weles-microsoft-primary-password',
    field: 'password',
    writerConsumer: 'weles-microsoft-primary-password-writer',
    writerTokenFile: 'weles-microsoft-primary-password-writer-skarbiec-token',
    readerConsumer: 'weles-microsoft-primary-password-reader',
    sourceOrigin: 'https://account.live.com',
    shape: 'password',
  }),
  // Entra directory identity: the directory owns this password and its lifecycle
  // runs at login.microsoftonline.com, never at account.live.com. The Entra
  // trajectory refuses any job whose secret_source_origin is not exactly that
  // origin (src/trajectories/microsoft/entra_password_lifecycle.mjs).
  'weles-microsoft-jakub-wisent-ai-password': Object.freeze({
    item: 'weles-microsoft-jakub-wisent-ai-password',
    field: 'password',
    writerConsumer: 'weles-microsoft-jakub-wisent-ai-password-writer',
    writerTokenFile: 'weles-microsoft-jakub-wisent-ai-password-writer-skarbiec-token',
    readerConsumer: 'weles-microsoft-jakub-wisent-ai-password-reader',
    sourceOrigin: 'https://login.microsoftonline.com',
    shape: 'password',
  }),
  // A personal Microsoft account that only guests in the Entra tenant: the id
  // token for that principal names the Microsoft consumer tenant as its identity
  // provider and the directory does not hold its password, so its lifecycle is
  // the consumer one at account.live.com
  // (src/worker/deploy/skarbiec-acquisition-scopes.conf:103-111).
  'weles-microsoft-lukasz-wisent-com-password': Object.freeze({
    item: 'weles-microsoft-lukasz-wisent-com-password',
    field: 'password',
    writerConsumer: 'weles-microsoft-lukasz-wisent-com-password-writer',
    writerTokenFile: 'weles-microsoft-lukasz-wisent-com-password-writer-skarbiec-token',
    readerConsumer: 'weles-microsoft-lukasz-wisent-com-password-reader',
    sourceOrigin: 'https://account.live.com',
    shape: 'password',
  }),
} as const);

export type WelesAcquiredSecret = string;
export type InternalAcquiredSecretContract = {
  item: string;
  field: string;
  writerConsumer: string;
  writerTokenFile: string;
  readerConsumer?: string;
  // Null exactly when no table pins the site: an unenumerated provider has no
  // origin anyone could enumerate, so the signup origin Skarbiec recorded for the
  // acquire operation travels with the job and is checked at capture time.
  sourceOrigin: string | null;
  shape: string;
};
export type WelesAcquiredSecretContract = {
  item: string;
  field: string;
  sourceOrigin: string | null;
};

// One spelling of the signup origin, shared with the `signup_origin` record
// Skarbiec keeps for a generic acquire and with the bridge that carries it: an
// absolute HTTPS origin and nothing else, so a path, query, fragment, userinfo,
// trailing slash, or upper-case host is a different string and is refused rather
// than normalized into one.
export function isWelesAcquiredSourceOrigin(value: string): boolean {
  if (!value || value.length > Number('512')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

const GENERIC_ACQUIRED_ITEM = /^[a-z\d](?:[a-z\d-]{1,38}[a-z\d])$/;

export function resolvedAcquiredSecretContract(secret: string): InternalAcquiredSecretContract | null {
  const fixed = (ACQUIRED_SECRET_CONTRACTS as Readonly<Record<string, InternalAcquiredSecretContract>>)[secret];
  if (fixed) return fixed;
  // An item nobody enumerated still gets exactly one derived contract: its own
  // scoped writer and its own writer token file, so that operator-owned file
  // stays the only authority that can enable it — there is no fallback to
  // another consumer or token, and no reader consumer, so the derived contract
  // can never be read back. An item another contract already owns is refused
  // here: a derived contract must never reach a table item's or a scoped service
  // item's fields. An id that merely looks like a managed password lands here
  // too, with no source origin and no reader: only the table above may hand out
  // a provider surface, so a renamed or unenumerated item fails visibly at the
  // reader and shape gates instead of silently inheriting Microsoft's.
  if (!GENERIC_ACQUIRED_ITEM.test(secret)
    || Object.values(SERVICE_CONTRACTS).some((service) => service.item === secret)
    || Object.values(ACQUIRED_SECRET_CONTRACTS).some((contract) => contract.item === secret)) {
    return null;
  }
  return {
    item: secret,
    field: 'api_key',
    writerConsumer: `${secret}-writer`,
    writerTokenFile: `${secret}-writer-skarbiec-token`,
    sourceOrigin: null,
    shape: 'opaque-token',
  };
}

export function acquiredSecretContract(secret: string): WelesAcquiredSecretContract | null {
  const contract = resolvedAcquiredSecretContract(secret);
  return contract
    ? { item: contract.item, field: contract.field, sourceOrigin: contract.sourceOrigin }
    : null;
}

// Whether one exact declared contract owns this id and that contract is a managed
// password. Only the table at the head of this file can answer yes: a derived
// contract is always shape 'opaque-token', so a password shape means a human wrote
// the declaration for that exact id.
//
// This is the gate that decides the managed-password lifecycle applies at all, and
// it is deliberately a lookup rather than a pattern over the id. An id is a mutable
// human-chosen vault name: a rename that stops matching a pattern silently routes
// the item down some other path, while a rename that misses a declaration fails
// visibly and is fixed by editing the declaration.
export function isWelesManagedPasswordItem(secret: string): boolean {
  const contract = resolvedAcquiredSecretContract(secret);
  return contract?.shape === 'password';
}
