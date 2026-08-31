import {
  acquiredSecretContract,
  hasWelesAcquiredSecretWriter,
  hasWelesManagedCredentialReader,
  isWelesAcquiredSourceOrigin,
  welesManagedCredentialReaderMismatch,
} from './scoped-service.js';
import { enqueueAction, listAccounts } from '../state/skarbiec-records.js';

type SecretDefinition = {
	secret: string;
	provider: string;
	displayName: string;
	envVars: string[];
	defaultPurpose: string;
	formUrl: string;
	flowName: string;
	endpoints: string[];
	usageText: string;
	dailyRequests: string;
	requestedScopes: string[];
	capabilities: string[];
	runtimeInstall: boolean;
	headless: boolean;
  storeSecretTarget: 'skarbiec';
  operations?: string[];
  // Only a derived generic definition carries this: it is the site the caller
  // declared for an unenumerated provider, empty when none was declared. A
  // registered definition leaves it absent and keeps the origin its exact
  // Skarbiec contract pins.
  sourceOrigin?: string;
};



export type CredentialOperation = 'acquire' | 'adopt' | 'rotate' | 'verify' | 'remove' | 'reset';

export type AcquireSecretRequest = {
  operation?: CredentialOperation;
  credentialId?: string;
  provider?: string;
  requestId?: string;
  goal?: string;
  secret?: string;
  purpose?: string;
  dryRun?: boolean;
  autoPromoteTrajectory?: boolean;
  proxy?: string;
  headless?: boolean;
  priority?: number;
  tenantId?: string | null;
  accountEmail?: string;
  accountUpn?: string;
  principalObjectId?: string;
  signupOrigin?: string;
};

export type AcquireSecretResult =
  | {
      status: 'operation_plan';
      operation: CredentialOperation;
      secret: string;
      provider: string;
      vaultItemId: string;
      url: string;
      objective: string;
      params: Record<string, unknown>;
    }
  | {
      status: 'operation_queued';
      operation: 'acquire';
      secret: string;
      provider: string;
      buildId: string;
      actionLogId: string;
      action: 'generic_keeper_task';
      flowName: string;
      message: string;
      vaultItemId?: string;
    }
  | {
      status: 'operation_queued';
      operation: 'acquire';
      vaultItemId: string;
      secret: string;
      provider: string;
      sourceActionLogId: string;
      actionLogId: string;
      action: 'semanticscholar_key_followup';
      flowName: 'semantic-scholar-key-followup';
      scheduledAt?: string;
      alreadyQueued: boolean;
      message: string;
    }
  | {
      status: 'operation_queued';
      operation: 'adopt' | 'rotate' | 'verify';
      secret: string;
      provider: 'microsoft';
      actionLogId: string;
      action: 'microsoft_adopt_password' | 'microsoft_reset_password' | 'microsoft_verify_password';
      flowName: 'microsoft-password-lifecycle';
      vaultItemId: string;
      message: string;
    }
  | {
      status: 'operation_queued';
      operation: 'adopt' | 'rotate' | 'verify' | 'reset';
      secret: string;
      provider: 'microsoft_entra';
      actionLogId: string;
      action: 'microsoft_entra_adopt_password' | 'microsoft_entra_reset_password' | 'microsoft_entra_verify_password';
      flowName: 'microsoft-entra-password-lifecycle';
      vaultItemId: string;
      message: string;
    }
  | {
      status: 'followup_queued';
      secret: string;
      provider: string;
      sourceActionLogId: string;
      actionLogId?: string;
      action: 'semanticscholar_key_followup';
      flowName: 'semantic-scholar-key-followup';
      scheduledAt?: string;
      alreadyQueued: boolean;
      message: string;
    }
  | {
      status: 'needs_configuration';
      operation?: CredentialOperation;
      secret: string;
      provider: string;
      vaultItemId: string;
      missing: string[];
      message: string;
    }
  | {
      status: 'unsupported_operation';
      operation: CredentialOperation;
      secret: string;
      provider: string;
      message: string;
    }
  | {
      status: 'unsupported_secret';
      operation?: CredentialOperation;
      secret: string;
      message: string;
    };

const MICROSOFT_PASSWORD_ID = /^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$/;

function microsoftPasswordDefinition(credentialId: string): SecretDefinition {
  return {
    secret: credentialId,
    provider: 'microsoft',
    displayName: 'Microsoft account password',
    envVars: [],
    defaultPurpose: 'microsoft-account-security',
    formUrl: 'https://account.live.com/password/Change',
    flowName: 'microsoft-password-lifecycle',
    endpoints: ['Microsoft account sign-in'],
    usageText: 'Adopt, rotate, or verify one exact Microsoft account password and commit it to Skarbiec only after a fresh password login succeeds.',
    dailyRequests: '1',
    requestedScopes: [],
    capabilities: ['password_adoption', 'password_rotation', 'fresh_login_verification'],
    runtimeInstall: false,
    headless: false,
    storeSecretTarget: 'skarbiec',
    operations: ['adopt', 'rotate', 'verify'],
  };
}

const ENTRA_PROVIDER = 'microsoft_entra';
const ENTRA_ORIGIN = 'https://login.microsoftonline.com';
const ENTRA_UPN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LOWER_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

// Entra directory items share the managed-password credential id shape with
// consumer Microsoft accounts (MICROSOFT_PASSWORD_ID); the requested provider
// selects which lifecycle owns the item, so a directory identity is never
// administered through a consumer-account surface.
function entraPasswordDefinition(credentialId: string): SecretDefinition {
  return {
    secret: credentialId,
    provider: ENTRA_PROVIDER,
    displayName: 'Microsoft Entra account password',
    envVars: [],
    defaultPurpose: 'entra-account-security',
    formUrl: ENTRA_ORIGIN,
    flowName: 'microsoft-entra-password-lifecycle',
    endpoints: ['Microsoft Entra sign-in'],
    usageText: 'Adopt, rotate, reset, or verify one exact Microsoft Entra directory password and commit it to Skarbiec only after the signed-in tenant, principal object id, and UPN are confirmed by a fresh login.',
    dailyRequests: '1',
    requestedScopes: [],
    capabilities: ['password_adoption', 'password_rotation', 'password_reset', 'fresh_login_verification'],
    runtimeInstall: false,
    headless: false,
    storeSecretTarget: 'skarbiec',
    operations: ['adopt', 'rotate', 'reset', 'verify'],
  };
}
const SEMANTIC_SCHOLAR: SecretDefinition = {
  secret: 'semantic_scholar.api_key',
  provider: 'semantic_scholar',
  displayName: 'Semantic Scholar',
  envVars: ['SEMANTIC_SCHOLAR_API_KEY', 'S2_API_KEY'],
  defaultPurpose: 'lem',
  formUrl: 'https://www.semanticscholar.org/product/api#api-key-form',
  flowName: 'semantic-scholar-api-key-request',
  endpoints: ['/graph/v1/paper/search', '/graph/v1/paper/{paper_id}', '/graph/v1/author/search'],
  usageText: 'We use the Semantic Scholar Academic Graph API to retrieve paper metadata, abstracts, authors, venues, citation counts, identifiers, and related-paper signals for a local research-paper assistant. Requests are used for indexing and contextualizing academic papers selected by the user, not for bulk redistribution.',
  dailyRequests: '1000',
  requestedScopes: [],
  capabilities: ['paper_search', 'citation_metadata', 'related_papers'],
  runtimeInstall: true,
  headless: false,
  storeSecretTarget: 'skarbiec',
};

const GITHUB_ADMIN_TOKEN: SecretDefinition = {
  secret: 'github.admin_org_token',
  provider: 'github',
  displayName: 'GitHub admin org token',
  envVars: ['PEOPLE_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  defaultPurpose: 'people-router-lifecycle',
  formUrl: 'https://github.com/settings/tokens/new',
  flowName: 'github-admin-org-token-acquisition',
  endpoints: ['/user', '/orgs/{org}/memberships/{username}', '/orgs/{org}/teams/{team}/memberships/{username}'],
  usageText: 'We use a GitHub organization-admin token so people-router can administer employee organization and team membership during onboarding and offboarding (invite member, add/remove team membership, remove collaborator). The token must carry the admin:org scope. It is used only for lifecycle administration of the configured organization, not for repository content changes.',
  dailyRequests: '500',
  requestedScopes: ['admin:org', 'read:org'],
  capabilities: ['org_membership_admin', 'team_membership_admin'],
  runtimeInstall: true,
  headless: false,
  storeSecretTarget: 'skarbiec',
};
const FIGMA_PERSONAL_ACCESS_TOKEN: SecretDefinition = {
  secret: 'figma.personal_access_token',
  provider: 'figma',
  displayName: 'Figma Personal Access Token',
  envVars: ['FIGMA_ACCESS_TOKEN'],
  defaultPurpose: 'design-assets-export',
  formUrl: 'https://www.figma.com/settings?tab=security',
  flowName: 'figma-personal-access-token-acquisition',
  endpoints: ['/v1/me', '/v1/files/{file_key}', '/v1/images/{file_key}', '/v1/files/{file_key}/versions', '/v1/folders/{folder_id}/files'],
  usageText: 'We use the read-only Figma REST API to archive company design files, version metadata, published libraries, and rendered image assets in the Wisent design-assets repository. The token is stored directly in Skarbiec and is never returned in Weles results.',
  dailyRequests: '500',
  requestedScopes: [
    'current_user:read',
    'file_content:read',
    'file_metadata:read',
    'file_versions:read',
    'folders:read',
    'folder_metadata:read',
    'library_assets:read',
    'library_content:read',
    'team_library_content:read',
  ],
  capabilities: ['company_design_archive', 'file_content_export', 'asset_rendering', 'version_inventory'],
  runtimeInstall: false,
  headless: false,
  storeSecretTarget: 'skarbiec',
};


const SNAPCHAT_SNAP_KIT_API_TOKEN: SecretDefinition = {
  secret: 'snapchat.snap_kit_api_token',
  provider: 'snapchat',
  displayName: 'Snapchat Snap Kit production API token',
  envVars: ['SNAPCHAT_SNAP_KIT_API_TOKEN'],
  defaultPurpose: 'snap-kit-api',
  formUrl: 'https://kit.snapchat.com/manage/',
  flowName: 'snapchat-snap-kit-api-token-acquisition',
  endpoints: ['Snap Kit production API'],
  usageText: 'We use the production Snap Kit API token to authenticate the configured Snap Kit integration. Reuse the existing organization and project when present. Create a project only when none exists, and generate the production API token without exposing it in task results.',
  dailyRequests: '100',
  requestedScopes: [],
  capabilities: ['snap_kit_api'],
  runtimeInstall: true,
  headless: false,
  storeSecretTarget: 'skarbiec',
};

const SECRET_REGISTRY: Record<string, SecretDefinition> = {
  [SEMANTIC_SCHOLAR.secret]: SEMANTIC_SCHOLAR,
  semantic_scholar_api_key: SEMANTIC_SCHOLAR,
  semantic_scholar: SEMANTIC_SCHOLAR,
  s2_api_key: SEMANTIC_SCHOLAR,
  [GITHUB_ADMIN_TOKEN.secret]: GITHUB_ADMIN_TOKEN,
  github_admin_org_token: GITHUB_ADMIN_TOKEN,
  github_admin_token: GITHUB_ADMIN_TOKEN,
  github_org_admin_token: GITHUB_ADMIN_TOKEN,
  [FIGMA_PERSONAL_ACCESS_TOKEN.secret]: FIGMA_PERSONAL_ACCESS_TOKEN,
  figma_personal_access_token: FIGMA_PERSONAL_ACCESS_TOKEN,
  figma_access_token: FIGMA_PERSONAL_ACCESS_TOKEN,
  figma_api_token: FIGMA_PERSONAL_ACCESS_TOKEN,
  [SNAPCHAT_SNAP_KIT_API_TOKEN.secret]: SNAPCHAT_SNAP_KIT_API_TOKEN,
  snapchat_snap_kit_api_token: SNAPCHAT_SNAP_KIT_API_TOKEN,
  snapchat_api_token: SNAPCHAT_SNAP_KIT_API_TOKEN,
};

// A provider nobody registered above is still acquirable. The shared credential
// contract fixes the slug shape, the api_key field, and acquire as the only
// operation; Skarbiec names the item (the slug, unless the caller passed an
// explicit credential id). Everything else is the registered path unchanged: the
// same scoped-writer gate, the same store_credential contract, the same
// capture-origin check.
const GENERIC_SLUG = /^[a-z\d](?:[a-z\d-]{1,38}[a-z\d])$/;
const GENERIC_FIELD = 'api_key';
const GENERIC_FLOW = 'generic-provider-api-key-acquisition';
// A slug names no site, so a request that declares no signup origin starts the
// browser job at exactly this discovery origin and finds the provider's own
// API-key signup page from there instead of guessing a hostname from the slug.
const GENERIC_DISCOVERY_ORIGIN = 'https://duckduckgo.com';

function genericDefinition(request: AcquireSecretRequest): SecretDefinition | null {
  const provider = request.provider?.trim().toLowerCase() ?? '';
  if (!GENERIC_SLUG.test(provider)
      || provider === 'microsoft'
      || provider === ENTRA_PROVIDER
      || Object.values(SECRET_REGISTRY).some((definition) => definition.provider === provider)) {
    return null;
  }
  const item = request.credentialId?.trim().toLowerCase() || provider;
  // The derived Skarbiec contract decides whether this item may be acquired at
  // all: it refuses a registered item, a managed password id, and a scoped
  // service item, so a generic request can never land on another contract's item.
  const contract = acquiredSecretContract(item);
  if (!contract || contract.item !== item || contract.field !== GENERIC_FIELD) return null;
  const declaredOrigin = request.signupOrigin?.trim() ?? '';
  const displayName = provider.replace(/-/g, ' ');
  return {
    secret: item,
    provider,
    displayName,
    envVars: [],
    defaultPurpose: `${provider}-api-access`,
    formUrl: isWelesAcquiredSourceOrigin(declaredOrigin)
      ? declaredOrigin
      : `${GENERIC_DISCOVERY_ORIGIN}/?q=${encodeURIComponent(`${displayName} API key sign up`)}`,
    flowName: GENERIC_FLOW,
    endpoints: [`${displayName} API`],
    usageText: `We register one Wisent-owned account with ${displayName} and generate a single API key for programmatic access from our own services. The key is written straight into the encrypted Skarbiec item and never appears in task results, logs, or tool arguments.`,
    dailyRequests: '100',
    requestedScopes: [],
    capabilities: ['account_signup', 'api_key_generation'],
    runtimeInstall: false,
    headless: false,
    storeSecretTarget: 'skarbiec',
    operations: ['acquire'],
    sourceOrigin: declaredOrigin,
  };
}


function normalizeSecret(request: AcquireSecretRequest): string {
  const credentialId = request.credentialId?.trim().toLowerCase() ?? '';
  if (MICROSOFT_PASSWORD_ID.test(credentialId)) return credentialId;
  const explicit = request.secret?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (explicit) return explicit.includes('.') ? explicit.replace(/_/g, '_') : explicit;
  const goal = request.goal?.toLowerCase() ?? '';
  if ((goal.includes('semantic') && goal.includes('scholar')) || goal.includes('semanticscholar') || goal.includes('s2')) {
    return SEMANTIC_SCHOLAR.secret;
  }
  if (goal.includes('github') && (goal.includes('admin') || goal.includes('org') || goal.includes('token'))) {
    return GITHUB_ADMIN_TOKEN.secret;
  }
  if (goal.includes('supabase') && (goal.includes('api') || goal.includes('key') || goal.includes('token') || goal.includes('klucz'))) {
  }
  if (goal.includes('figma') && (goal.includes('api') || goal.includes('token') || goal.includes('asset') || goal.includes('design'))) {
    return FIGMA_PERSONAL_ACCESS_TOKEN.secret;
  }
  if (goal.includes('snapchat') && (goal.includes('api') || goal.includes('token') || goal.includes('snap kit'))) {
    return SNAPCHAT_SNAP_KIT_API_TOKEN.secret;
  }
  return '';
}

function definitionFor(request: AcquireSecretRequest): SecretDefinition | null {
  const normalized = normalizeSecret(request);
  if (MICROSOFT_PASSWORD_ID.test(normalized)) {
    return request.provider === ENTRA_PROVIDER
      ? entraPasswordDefinition(normalized)
      : microsoftPasswordDefinition(normalized);
  }
  const registered = normalized
    ? SECRET_REGISTRY[normalized] ?? SECRET_REGISTRY[normalized.replace(/\./g, '_')] ?? null
    : null;
  return registered ?? genericDefinition(request);
}






function purposeFor(request: AcquireSecretRequest, def: SecretDefinition): string {
  const purpose = request.purpose?.trim();
  if (purpose) return purpose;
  const goal = request.goal?.toLowerCase() ?? '';
  if (goal.includes('lem')) return 'lem';
  return def.defaultPurpose;
}


function objectiveFor(def: SecretDefinition, request: AcquireSecretRequest, accountEmail: string): string {
  const purpose = purposeFor(request, def);
  const contract = acquiredSecretContract(def.secret);
  if (!contract) throw new Error(`missing exact Skarbiec acquisition contract for ${def.secret}`);
  if (def.provider === ENTRA_PROVIDER) {
    const operation = request.operation ?? 'acquire';
    const accountUpn = request.accountUpn?.trim().toLowerCase() ?? '';
    return [
      `${operation} the Microsoft Entra directory password for the exact identity ${accountUpn}.`,
      `Confirm that the authorized session claims carry tenant ${request.tenantId ?? ''} and principal object id ${request.principalObjectId ?? ''} before any password write and again after the fresh login.`,
      operation === 'verify'
        ? 'Perform a fresh password authentication and rewrite the same managed value only after Entra accepts it.'
        : operation === 'adopt'
          ? 'The current password is already known to the operator and staged in Skarbiec: read that staged candidate, prove it with a fresh Entra login, and never change the password in the directory.'
          : operation === 'reset'
            ? 'The current password is unknown: drive the Entra self-service reset and return needs_human_approval for every interactive identity verification instead of attempting to satisfy it.'
            : 'Generate a new strong password in-process, change it in the Entra directory, perform a fresh password authentication, and only then commit it to Skarbiec.',
      'If any step after the directory accepts the candidate fails, restore the previous password and verify the restored password before returning operation_failed.',
      'If Entra requires interactive identity approval, stop as needs_human_approval without changing Skarbiec.',
      `The encrypted target is ${contract.item} field ${contract.field}; never emit the password in logs or task results.`,
    ].join(' ');
  }
  if (def.provider === 'microsoft') {
    const operation = request.operation ?? 'acquire';
    return [
      `${operation} the password for the exact Microsoft account ${accountEmail}.`,
      'Use only the queued account session and the exact Skarbiec credential contract.',
      operation === 'verify'
        ? 'Perform a fresh password authentication and rewrite the same managed value only after Microsoft accepts it.'
        : operation === 'adopt'
          ? 'The current password is already known to the operator and staged in Skarbiec: read that staged candidate, prove it with a fresh Microsoft login, and never change the password at the provider.'
          : 'Generate a new strong password in-process, change it at Microsoft, perform a fresh password authentication, and only then commit it to Skarbiec.',
      'If any step after Microsoft accepts the candidate fails, restore the previous password through its opaque capability and verify the restored password before returning operation_failed. If that rollback cannot be verified, return needs_human_approval and leave the staged Skarbiec candidate intact.',
      'If Microsoft requires interactive identity approval, stop as needs_human_approval without changing Skarbiec.',
      `The encrypted target is ${contract.item} field ${contract.field}; never emit the password in logs or task results.`,
    ].join(' ');
  }
  if (def.provider === 'figma') {
    return [
      `Acquire ${def.displayName} for ${purpose}.`,
      accountEmail
        ? `Use the existing authenticated account ${accountEmail}. If sign-in is required, use only the configured Google SSO credential capability or saved browser session; never ask for or expose its password.`
        : '',
      'Open account Settings, select Security, and scroll to Personal access tokens.',
      'Create one token named "Wisent design-assets export" with the longest offered expiration.',
      `Grant exactly these read-only scopes and no write scope: ${def.requestedScopes.join(', ')}.`,
      `The token will access only these endpoints: ${def.endpoints.join(', ')}.`,
      `When the generated token is visible, call store_credential(target, 'api-key') on the token element. Never pass the token to done, logs, tool arguments, clipboard, or normal result data.`,
      `Finish only after store_credential confirms the exact encrypted Skarbiec item ${contract.item} field ${contract.field} write.`,
    ].filter(Boolean).join(' ');
  }
  const fieldClass = contract.field === 'api_key'
    ? 'api-key'
    : contract.field === 'password'
      ? 'password'
      : 'token';
  const accountInstruction = accountEmail
    ? `Use the existing authenticated account ${accountEmail}. If sign-in is required, choose that account and use only the configured credential capability or saved browser session; never ask for or expose its password.`
    : '';
  const completionInstruction = `When the generated credential is visible, call store_credential(target, '${fieldClass}') on the credential element. Never pass the credential to done, logs, tool arguments, or normal result data. Finish only after store_credential confirms the exact encrypted Skarbiec item ${contract.item} field ${contract.field} write.`;
  const mode = 'Submit the request after all required fields are filled. Use Weles-generated or invented applicant details for identity, affiliation, organization, role, website, country, and other registration profile fields; do not ask the user for personal or organization data. If CAPTCHA, reCAPTCHA, or Turnstile appears, call solve_captcha and continue after it reports success; only return needs_human_approval after solve_captcha reports failure or mailbox/key-delivery access cannot be completed.';
  return [
    `Acquire ${def.displayName} API access for ${purpose}.`,
    accountInstruction,
    def.sourceOrigin === undefined
      ? ''
      : def.sourceOrigin
        ? `The provider site is exactly ${def.sourceOrigin}: complete the sign-up and the key generation there, and capture the credential on that origin only.`
        : `No provider site was declared: from this discovery page find the official ${def.displayName} developer site, open the provider's own origin, and complete the sign-up and the key generation there.`,
    `Use case: ${def.usageText}`,
    `Requested endpoints: ${def.endpoints.join(', ')}.`,
    `Expected daily requests: ${def.dailyRequests}.`,
    mode,
    completionInstruction,
  ].filter(Boolean).join(' ');
}

function paramsFor(def: SecretDefinition, request: AcquireSecretRequest): Record<string, unknown> {
  const autoPromote = request.autoPromoteTrajectory !== false;
  const accountEmail = request.accountEmail?.trim().toLowerCase()
    ?? request.goal?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()
    ?? '';
  const contract = acquiredSecretContract(def.secret);
  if (!contract) throw new Error(`missing exact Skarbiec acquisition contract for ${def.secret}`);
  return {
    url: def.formUrl,
    objective: objectiveFor(def, request, accountEmail),
    flow_name: def.flowName,
    execution_mode: 'keeper_first',
    proxy: request.proxy ?? 'none',
    headless: request.headless ?? def.headless,
    auto_promote_trajectory: autoPromote,
    constraints: {
      secret: def.secret,
      operation: request.operation ?? 'acquire',
      request_id: request.requestId,
      purpose: purposeFor(request, def),
      account_email: accountEmail || undefined,
      store_secret_target: def.storeSecretTarget,
      vault_item_id: contract.item,
      vault_field: contract.field,
      // A registered item pins its source origin in the Skarbiec contract. A
      // generic item has none to pin, so the declared signup origin travels with
      // the job and the worker checks the capture page against exactly it.
      secret_source_origin: contract.sourceOrigin ?? def.sourceOrigin ?? '',
      // For microsoft_entra the directory block below is the only source of the
      // identity, so the flat binding tenant stays empty for that provider.
      tenant_id: def.provider === ENTRA_PROVIDER ? undefined : (request.tenantId ?? undefined),
      ...(def.provider === ENTRA_PROVIDER
        ? {
            // The directory identity is the item's own write-once contract, not a
            // call argument: the trajectory reads it from exactly this block. The
            // Entra directory id here is not a Weles Skarbiec binding tenant, so
            // the scoped reader and writer stay on the untenanted host binding.
            // Always these four keys: the block is a fixed-shape contract, so a
            // request without coordinates emits empty strings that fail closed at
            // the bridge rather than dropping keys JSON.stringify would erase.
            directory: {
              provider: ENTRA_PROVIDER,
              tenant_id: request.tenantId?.trim().toLowerCase() ?? '',
              principal_object_id: request.principalObjectId?.trim().toLowerCase() ?? '',
              account_upn: request.accountUpn?.trim().toLowerCase() ?? '',
            },
            weles_tenant_id: null,
          }
        : {}),
      display_name: def.displayName,
      env_var: def.envVars[0],
      env_vars: def.envVars,
      provider: def.provider,
      capabilities: def.capabilities,
      requested_scopes: def.requestedScopes,
      requested_endpoints: def.endpoints,
      expected_daily_requests: def.dailyRequests,
      runtime_install: def.runtimeInstall,
    },
    env: {},
  };
}

function queueAction(action: string, accountItem: string, params: Record<string, unknown>, priority = 0): string {
  return enqueueAction(action, accountItem, { ...params, priority });
}

type MicrosoftAccountRow = {
  id: string;
  username: string;
  active: boolean;
  metadata: { email?: string; skarbiec_credential_id?: string; skarbiec_tenant_id?: string };
};

function microsoftAccountBinding(
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

async function queueMicrosoftPasswordOperation(
  def: SecretDefinition,
  request: AcquireSecretRequest,
): Promise<AcquireSecretResult> {
  const operation = request.operation ?? 'acquire';
  if (operation !== 'adopt' && operation !== 'rotate' && operation !== 'verify') {
    return {
      status: 'unsupported_operation',
      secret: def.secret,
      operation,
      provider: def.provider,
      message: `${operation} is not supported for a Microsoft account password`,
    };
  }
  const accountEmail = request.accountEmail?.trim().toLowerCase() ?? '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)) {
    return {
      status: 'needs_configuration',
      secret: def.secret,
      vaultItemId: def.secret,
      operation,
      provider: def.provider,
      missing: ['one exact Microsoft account email'],
      message: 'Microsoft password operations require one exact account email',
    };
  }
  const binding = microsoftAccountBinding(accountEmail, def.secret, request.tenantId);
  const accountId = binding.accountId;
  const missing = [
    ...(!/^[a-f0-9]{64}$/i.test(request.requestId ?? '') ? ['one exact credential operation request id'] : []),
    ...(!accountId && !binding.error ? ['one uniquely matching active Microsoft account'] : []),
    ...(binding.error ? [binding.error] : []),
    ...(!hasWelesAcquiredSecretWriter(def.secret, request.tenantId)
      ? [`scoped Skarbiec writer for ${def.secret}`]
      : []),
    // A reader that is missing because the deployed catalog grants the item on
    // another field is a different fix from a reader nobody declared, so say
    // which one it is rather than reporting both as an absent grant.
    ...(!hasWelesManagedCredentialReader(def.secret, 'password', request.tenantId)
      ? [welesManagedCredentialReaderMismatch(def.secret, 'password', request.tenantId)
        ?? `tenant-scoped Skarbiec reader for ${def.secret}/password`]
      : []),
  ];
  if (missing.length) {
    return {
      status: 'needs_configuration',
      operation,
      secret: def.secret,
      vaultItemId: def.secret,
      provider: def.provider,
      missing,
      message: `Cannot enqueue Microsoft password ${operation} without ${missing.join(', ')}`,
    };
  }
  const params = paramsFor(def, { ...request, accountEmail });
  const action = operation === 'adopt'
    ? 'microsoft_adopt_password'
    : operation === 'verify'
      ? 'microsoft_verify_password'
      : 'microsoft_reset_password';
  const actionLogId = queueAction(action, accountId!, params, request.priority ?? 10);
  return {
    status: 'operation_queued',
    operation,
    secret: def.secret,
    provider: 'microsoft',
    actionLogId,
    action,
    flowName: 'microsoft-password-lifecycle',
    vaultItemId: def.secret,
    message: `Microsoft password ${operation} queued; Skarbiec remains pending until fresh-login verification ${operation === 'adopt' ? 'activates the staged candidate' : 'rewrites the managed item'}`,
  };
}

type EntraAccountRow = MicrosoftAccountRow & {
  metadata: MicrosoftAccountRow['metadata'] & {
    entra_upn?: string;
    entra_tenant_id?: string;
    entra_principal_object_id?: string;
  };
};

function entraAccountBinding(
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

async function queueEntraPasswordOperation(
  def: SecretDefinition,
  request: AcquireSecretRequest,
): Promise<AcquireSecretResult> {
  const operation = request.operation ?? 'acquire';
  if (operation !== 'adopt' && operation !== 'rotate' && operation !== 'reset' && operation !== 'verify') {
    return {
      status: 'unsupported_operation',
      secret: def.secret,
      operation,
      provider: def.provider,
      message: `${operation} is not supported for a Microsoft Entra directory password`,
    };
  }
  const accountUpn = request.accountUpn?.trim().toLowerCase() ?? '';
  const tenantId = request.tenantId?.trim().toLowerCase() ?? '';
  const principalObjectId = request.principalObjectId?.trim().toLowerCase() ?? '';
  const contract = acquiredSecretContract(def.secret);
  // The Entra directory id addresses the identity, not a Weles Skarbiec tenant.
  const skarbiecTenantId = null;
  const coordinatesReady = ENTRA_UPN.test(accountUpn)
    && LOWER_UUID.test(tenantId)
    && LOWER_UUID.test(principalObjectId);
  const binding = coordinatesReady
    ? entraAccountBinding(accountUpn, def.secret, tenantId, principalObjectId, skarbiecTenantId)
    : { accountId: null } as { accountId: string | null; error?: string };
  const missing = [
    ...(!/^[a-f0-9]{64}$/i.test(request.requestId ?? '') ? ['one exact credential operation request id'] : []),
    ...(!ENTRA_UPN.test(accountUpn) ? ['one exact Entra account UPN'] : []),
    ...(!LOWER_UUID.test(tenantId) ? ['one exact lowercase Entra tenant id'] : []),
    ...(!LOWER_UUID.test(principalObjectId) ? ['one exact lowercase Entra principal object id'] : []),
    ...(contract?.field !== 'password' || contract.item !== def.secret
      ? [`exact Skarbiec password contract for ${def.secret}`]
      : []),
    ...(contract?.sourceOrigin !== ENTRA_ORIGIN
      ? [`Entra credential source origin ${ENTRA_ORIGIN} for ${def.secret}`]
      : []),
    ...(coordinatesReady && !binding.accountId && !binding.error
      ? ['one uniquely matching active account bound to the requested Entra identity']
      : []),
    ...(binding.error ? [binding.error] : []),
    ...(!hasWelesAcquiredSecretWriter(def.secret, skarbiecTenantId)
      ? [`scoped Skarbiec writer for ${def.secret}`]
      : []),
    ...(operation !== 'reset' && !hasWelesManagedCredentialReader(def.secret, 'password', skarbiecTenantId)
      ? [welesManagedCredentialReaderMismatch(def.secret, 'password', skarbiecTenantId)
        ?? `scoped Skarbiec reader for ${def.secret}/password`]
      : []),
  ];
  if (missing.length) {
    return {
      status: 'needs_configuration',
      operation,
      secret: def.secret,
      vaultItemId: def.secret,
      provider: def.provider,
      missing,
      message: `Cannot enqueue Entra password ${operation} without ${missing.join(', ')}`,
    };
  }
  const params = paramsFor(def, { ...request, accountUpn, tenantId, principalObjectId });
  const action = operation === 'verify'
    ? 'microsoft_entra_verify_password'
    : operation === 'adopt'
      ? 'microsoft_entra_adopt_password'
      : 'microsoft_entra_reset_password';
  const actionLogId = queueAction(action, binding.accountId!, params, request.priority ?? 10);
  return {
    status: 'operation_queued',
    operation,
    secret: def.secret,
    provider: ENTRA_PROVIDER,
    actionLogId,
    action,
    flowName: 'microsoft-entra-password-lifecycle',
    vaultItemId: def.secret,
    message: `Entra password ${operation} queued; Skarbiec remains pending until the fresh-login identity assertion rewrites the managed item`,
  };
}

async function queueAcquisition(def: SecretDefinition, request: AcquireSecretRequest): Promise<AcquireSecretResult> {
  const params = paramsFor(def, request);
  let vaultItemId: string | undefined;
  if (params.constraints && typeof params.constraints === 'object' && !Array.isArray(params.constraints)) {
    const constrainedItemId = (params.constraints as Record<string, unknown>).vault_item_id;
    if (typeof constrainedItemId === 'string') vaultItemId = constrainedItemId;
  }
  if (request.dryRun === true) {
    return {
      status: 'operation_plan',
      operation: 'acquire',
      secret: def.secret,
      vaultItemId: vaultItemId ?? def.secret,
      provider: def.provider,
      url: def.formUrl,
      objective: String(params.objective),
      params,
    };
  }

  const missing = [
    ...(!hasWelesAcquiredSecretWriter(def.secret, request.tenantId) ? [`scoped Skarbiec writer for ${def.secret}`] : []),
    ...(!/^[a-f0-9]{64}$/i.test(request.requestId ?? '') ? ['one exact credential operation request id'] : []),
  ];
  if (missing.length) {
    return {
      status: 'needs_configuration',
      secret: def.secret,
      vaultItemId: vaultItemId ?? def.secret,
      provider: def.provider,
      missing,
      message: `Cannot enqueue Weles acquisition without ${missing.join(', ')}`,
    };
  }

  const buildId = request.requestId!;
  const actionLogId = queueAction(
    'generic_keeper_task',
    '',
    { ...params, trajectory_build_id: buildId },
    request.priority ?? 10,
  );

  return {
    status: 'operation_queued',
    operation: 'acquire',
    secret: def.secret,
    provider: def.provider,
    buildId,
    actionLogId,
    action: 'generic_keeper_task',
    flowName: def.flowName,
    ...(vaultItemId ? { vaultItemId } : {}),
    message: `${def.displayName} API key acquisition queued via generic_keeper_task`,
  };
}

export async function acquireSecret(request: AcquireSecretRequest): Promise<AcquireSecretResult> {
  const def = definitionFor(request);
  if (!def) {
    const secret = normalizeSecret(request) || 'unknown';
    return { status: 'unsupported_secret', secret, message: `No secret acquisition registry entry for ${secret}` };
  }
  if (request.provider && request.provider !== def.provider) {
    return {
      status: 'unsupported_secret',
      secret: def.secret,
      message: `Credential ${def.secret} is not registered for provider ${request.provider}`,
    };
  }
  const operation = request.operation ?? 'acquire';
  if (def.operations && !def.operations.includes(operation)) {
    return {
      status: 'unsupported_operation',
      operation,
      secret: def.secret,
      provider: def.provider,
      message: `${operation} is not supported for ${def.secret}`,
    };
  }
  if (def.provider === ENTRA_PROVIDER) {
    return queueEntraPasswordOperation(def, request);
  }
  if (def.provider === 'microsoft') {
    return queueMicrosoftPasswordOperation(def, request);
  }
  if (operation !== 'acquire') {
    return {
      status: 'unsupported_operation',
      operation,
      secret: def.secret,
      provider: def.provider,
      message: `${operation} is not supported for ${def.secret}`,
    };
  }


  return queueAcquisition(def, request);
}

export function buildSecretAcquisitionPlan(request: AcquireSecretRequest): AcquireSecretResult {
  const def = definitionFor(request);
  if (!def) {
    const secret = normalizeSecret(request) || 'unknown';
    return { status: 'unsupported_secret', secret, message: `No secret acquisition registry entry for ${secret}` };
  }
  if (request.provider && request.provider !== def.provider) {
    return {
      status: 'unsupported_secret',
      secret: def.secret,
      message: `Credential ${def.secret} is not registered for provider ${request.provider}`,
    };
  }
  const operation = request.operation ?? 'acquire';
  if ((def.operations && !def.operations.includes(operation))
      || (!def.operations && operation !== 'acquire')) {
    return {
      status: 'unsupported_operation',
      operation,
      secret: def.secret,
      provider: def.provider,
      message: `${operation} is not supported for ${def.secret}`,
    };
  }
  // A plan for a directory provider without its sealed coordinates would
  // describe an operation nobody can execute: the queue path rejects it, and
  // the emitted directory block would carry empty identity fields. Refuse here
  // rather than hand back a plan the caller cannot act on.
  if (def.provider === ENTRA_PROVIDER) {
    const missing = [
      ...(ENTRA_UPN.test(request.accountUpn?.trim().toLowerCase() ?? '') ? [] : ['one exact account UPN']),
      ...(LOWER_UUID.test(request.tenantId?.trim().toLowerCase() ?? '') ? [] : ['one exact tenant id']),
      ...(LOWER_UUID.test(request.principalObjectId?.trim().toLowerCase() ?? '')
        ? []
        : ['one exact principal object id']),
    ];
    if (missing.length) {
      return {
        status: 'needs_configuration',
        operation,
        secret: def.secret,
        vaultItemId: def.secret,
        provider: def.provider,
        missing,
        message: `Cannot plan ${operation} for ${def.secret} without ${missing.join(', ')}`,
      };
    }
  }
  // A declared signup origin that is not one absolute https origin would send the
  // browser job to a target nobody named and could never match the capture
  // origin, so it is a configuration error, not a plan.
  if (def.sourceOrigin && !isWelesAcquiredSourceOrigin(def.sourceOrigin)) {
    return {
      status: 'needs_configuration',
      operation,
      secret: def.secret,
      vaultItemId: def.secret,
      provider: def.provider,
      missing: ['one exact absolute https signup origin'],
      message: `Cannot plan ${operation} for ${def.secret} without one exact absolute https signup origin`,
    };
  }
  const params = paramsFor(def, { ...request, dryRun: true });
  return {
    status: 'operation_plan',
    operation,
    secret: def.secret,
    vaultItemId: def.secret,
    provider: def.provider,
    url: def.formUrl,
    objective: String(params.objective),
    params,
  };
}
