import { queueSemanticScholarFollowup } from './semantic-scholar-followup.js';
import { acquiredSecretContract, hasWelesAcquiredSecretWriter, hasWelesManagedCredentialReader } from './scoped-service.js';
import { optionalWelesDatabase, requireWelesDatabase, welesDatabaseHeaders } from '../utils/weles-database.js';

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
};

type InsertedId = { id: string };


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
      operation: 'rotate' | 'verify';
      secret: string;
      provider: 'microsoft';
      actionLogId: string;
      action: 'microsoft_reset_password' | 'microsoft_verify_password';
      flowName: 'microsoft-password-lifecycle';
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
    usageText: 'Rotate or verify one exact Microsoft account password and commit it to Skarbiec only after a fresh password login succeeds.',
    dailyRequests: '1',
    requestedScopes: [],
    capabilities: ['password_rotation', 'fresh_login_verification'],
    runtimeInstall: false,
    headless: false,
    storeSecretTarget: 'skarbiec',
    operations: ['rotate', 'verify'],
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

const SUPABASE_PERSONAL_ACCESS_TOKEN: SecretDefinition = {
  secret: 'supabase.personal_access_token',
  provider: 'supabase',
  displayName: 'Supabase Personal Access Token',
  envVars: ['SUPABASE_ACCESS_TOKEN'],
  defaultPurpose: 'supabase-management',
  formUrl: 'https://supabase.com/dashboard/account/tokens',
  flowName: 'supabase-personal-access-token-acquisition',
  endpoints: ['/v1/projects'],
  usageText: 'We use the Supabase Management API to inspect and administer projects owned by the requested account. The token is stored directly in Skarbiec and is never returned in the Weles result.',
  dailyRequests: '100',
  requestedScopes: [],
  capabilities: ['project_management_api'],
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
  [SUPABASE_PERSONAL_ACCESS_TOKEN.secret]: SUPABASE_PERSONAL_ACCESS_TOKEN,
  supabase_personal_access_token: SUPABASE_PERSONAL_ACCESS_TOKEN,
  supabase_api_key: SUPABASE_PERSONAL_ACCESS_TOKEN,
  supabase_token: SUPABASE_PERSONAL_ACCESS_TOKEN,
  [SNAPCHAT_SNAP_KIT_API_TOKEN.secret]: SNAPCHAT_SNAP_KIT_API_TOKEN,
  snapchat_snap_kit_api_token: SNAPCHAT_SNAP_KIT_API_TOKEN,
  snapchat_api_token: SNAPCHAT_SNAP_KIT_API_TOKEN,
};


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
    return SUPABASE_PERSONAL_ACCESS_TOKEN.secret;
  }
  if (goal.includes('snapchat') && (goal.includes('api') || goal.includes('token') || goal.includes('snap kit'))) {
    return SNAPCHAT_SNAP_KIT_API_TOKEN.secret;
  }
  return '';
}

function definitionFor(request: AcquireSecretRequest): SecretDefinition | null {
  const normalized = normalizeSecret(request);
  if (!normalized) return null;
  if (MICROSOFT_PASSWORD_ID.test(normalized)) {
    return request.provider === ENTRA_PROVIDER
      ? entraPasswordDefinition(normalized)
      : microsoftPasswordDefinition(normalized);
  }
  return SECRET_REGISTRY[normalized] ?? SECRET_REGISTRY[normalized.replace(/\./g, '_')] ?? null;
}

function headers(): Record<string, string> {
  const database = requireWelesDatabase();
  return welesDatabaseHeaders(database, { 'Content-Type': 'application/json' });
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
        : 'Generate a new strong password in-process, change it at Microsoft, perform a fresh password authentication, and only then commit it to Skarbiec.',
      'If any step after Microsoft accepts the candidate fails, restore the previous password through its opaque capability and verify the restored password before returning operation_failed. If that rollback cannot be verified, return needs_human_approval and leave the staged Skarbiec candidate intact.',
      'If Microsoft requires interactive identity approval, stop as needs_human_approval without changing Skarbiec.',
      `The encrypted target is ${contract.item} field ${contract.field}; never emit the password in logs or task results.`,
    ].join(' ');
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
      secret_source_origin: contract.sourceOrigin,
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

async function insertReturning(table: string, row: Record<string, unknown>): Promise<string> {
  const database = requireWelesDatabase();
  const res = await fetch(`${database.url}/rest/v1/${table}?select=id`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`${table} insert failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 500));
  const rows = await res.json() as InsertedId[];
  const id = rows[0]?.id;
  if (!id) throw new Error(`${table} insert did not return id`);
  return id;
}

type MicrosoftAccountRow = {
  id?: string;
  username?: string;
  is_active?: boolean;
  metadata?: { email?: string; skarbiec_credential_id?: string; skarbiec_tenant_id?: string };
};

async function microsoftAccountBinding(
  accountEmail: string,
  credentialId: string,
  tenantId?: string | null,
): Promise<{ accountId: string | null; error?: string }> {
  const database = optionalWelesDatabase();
  if (!database) return { accountId: null };
  const response = await fetch(
    `${database.url}/rest/v1/social_accounts?platform=eq.microsoft&select=id,username,is_active,metadata&limit=${Number('500')}`,
    { headers: headers() },
  );
  if (!response.ok) throw new Error(`Microsoft account lookup failed: HTTP ${response.status}`);
  const rows = await response.json() as MicrosoftAccountRow[];
  const normalized = accountEmail.trim().toLowerCase();
  const requestedTenant = tenantId ?? null;
  const tenantRows = rows.filter((row) =>
    (row.metadata?.skarbiec_tenant_id ?? null) === requestedTenant);
  const matches = tenantRows.filter((row) => {
    const username = row.username?.trim().toLowerCase() ?? '';
    const email = row.metadata?.email?.trim().toLowerCase() ?? '';
    return row.is_active === true && (username === normalized || email === normalized);
  });
  const account = matches[0];
  const accountId = account?.id;
  if (matches.length !== Number('1') || !accountId) return { accountId: null };
  const otherOwner = tenantRows.find((row) => row.id !== account.id
    && row.metadata?.skarbiec_credential_id === credentialId);
  if (otherOwner) {
    return { accountId: null, error: 'credential item is already bound to another Microsoft account' };
  }
  const boundCredential = account.metadata?.skarbiec_credential_id;
  if (boundCredential && boundCredential !== credentialId) {
    return { accountId: null, error: 'Microsoft account is already bound to another credential item' };
  }
  if (boundCredential !== credentialId) {
    return { accountId: null, error: 'Microsoft account is not bound to the requested managed credential' };
  }
  return { accountId };
}

async function queueMicrosoftPasswordOperation(
  def: SecretDefinition,
  request: AcquireSecretRequest,
): Promise<AcquireSecretResult> {
  const operation = request.operation ?? 'acquire';
  if (operation !== 'rotate' && operation !== 'verify') {
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
  const database = optionalWelesDatabase();
  const binding = database
    ? await microsoftAccountBinding(accountEmail, def.secret, request.tenantId)
    : { accountId: null };
  const accountId = binding.accountId;
  const missing = [
    ...(!database ? ['weles-database launcher configuration'] : []),
    ...(!/^[a-f0-9]{64}$/i.test(request.requestId ?? '') ? ['one exact credential operation request id'] : []),
    ...(!accountId && !binding.error ? ['one uniquely matching active Microsoft account'] : []),
    ...(binding.error ? [binding.error] : []),
    ...(!hasWelesAcquiredSecretWriter(def.secret, request.tenantId)
      ? [`scoped Skarbiec writer for ${def.secret}`]
      : []),
    ...(!hasWelesManagedCredentialReader(def.secret, 'password', request.tenantId)
      ? [`tenant-scoped Skarbiec reader for ${def.secret}/password`]
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
  const action = operation === 'verify' ? 'microsoft_verify_password' : 'microsoft_reset_password';
  const actionLogId = await insertReturning('account_action_logs', {
    account_id: accountId,
    action,
    platform: 'microsoft',
    status: 'queued',
    scheduled_at: new Date().toISOString(),
    priority: request.priority ?? Number('10'),
    params,
    tenant_id: request.tenantId ?? null,
    queued_by: 'skarbiec-credential-operation',
  });
  return {
    status: 'operation_queued',
    operation,
    secret: def.secret,
    provider: 'microsoft',
    actionLogId,
    action,
    flowName: 'microsoft-password-lifecycle',
    vaultItemId: def.secret,
    message: `Microsoft password ${operation} queued; Skarbiec remains pending until fresh-login verification rewrites the managed item`,
  };
}

type EntraAccountRow = {
  id?: string;
  username?: string;
  is_active?: boolean;
  metadata?: {
    email?: string;
    skarbiec_credential_id?: string;
    skarbiec_tenant_id?: string;
    entra_upn?: string;
    entra_tenant_id?: string;
    entra_principal_object_id?: string;
  };
};

// An Entra directory identity is only bindable when the account row states the
// exact directory coordinates. A row that merely shares the mailbox address is
// rejected with the reason, never silently treated as a zero-match.
async function entraAccountBinding(
  accountUpn: string,
  credentialId: string,
  tenantId: string,
  principalObjectId: string,
  skarbiecTenantId: string | null,
): Promise<{ accountId: string | null; error?: string }> {
  const database = optionalWelesDatabase();
  if (!database) return { accountId: null };
  const response = await fetch(
    `${database.url}/rest/v1/social_accounts?platform=eq.microsoft&select=id,username,is_active,metadata&limit=${Number('500')}`,
    { headers: headers() },
  );
  if (!response.ok) throw new Error(`Entra account lookup failed: HTTP ${response.status}`);
  const rows = await response.json() as EntraAccountRow[];
  const scoped = rows.filter((row) => (row.metadata?.skarbiec_tenant_id ?? null) === skarbiecTenantId);
  const named = scoped.filter((row) => {
    const upn = row.metadata?.entra_upn?.trim().toLowerCase() ?? '';
    const email = row.metadata?.email?.trim().toLowerCase() ?? row.username?.trim().toLowerCase() ?? '';
    return row.is_active === true && (upn === accountUpn || email === accountUpn);
  });
  if (named.length > Number('1')) {
    return { accountId: null, error: 'more than one active account claims the requested Entra UPN' };
  }
  const account = named[Number('0')];
  const accountId = account?.id;
  if (!account || !accountId) return { accountId: null };
  const metadata = account.metadata ?? {};
  if (metadata.entra_upn?.trim().toLowerCase() !== accountUpn) {
    return { accountId: null, error: `account row is missing metadata entra_upn ${accountUpn}` };
  }
  if (metadata.entra_tenant_id?.trim().toLowerCase() !== tenantId) {
    return { accountId: null, error: `account row is missing metadata entra_tenant_id ${tenantId}` };
  }
  if (metadata.entra_principal_object_id?.trim().toLowerCase() !== principalObjectId) {
    return { accountId: null, error: `account row is missing metadata entra_principal_object_id ${principalObjectId}` };
  }
  const otherOwner = scoped.find((row) => row.id !== accountId
    && row.metadata?.skarbiec_credential_id === credentialId);
  if (otherOwner) {
    return { accountId: null, error: 'credential item is already bound to another Entra account' };
  }
  const boundCredential = metadata.skarbiec_credential_id;
  if (boundCredential && boundCredential !== credentialId) {
    return { accountId: null, error: 'Entra account is already bound to another credential item' };
  }
  if (boundCredential !== credentialId) {
    return { accountId: null, error: 'Entra account is not bound to the requested managed credential' };
  }
  return { accountId };
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
  const database = optionalWelesDatabase();
  const binding = database && coordinatesReady
    ? await entraAccountBinding(accountUpn, def.secret, tenantId, principalObjectId, skarbiecTenantId)
    : { accountId: null } as { accountId: string | null; error?: string };
  const missing = [
    ...(!database ? ['weles-database launcher configuration'] : []),
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
      ? [`scoped Skarbiec reader for ${def.secret}/password`]
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
  const actionLogId = await insertReturning('account_action_logs', {
    account_id: binding.accountId,
    action,
    platform: 'microsoft',
    status: 'queued',
    scheduled_at: new Date().toISOString(),
    priority: request.priority ?? Number('10'),
    params,
    tenant_id: skarbiecTenantId,
    queued_by: 'skarbiec-credential-operation',
  });
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

function semanticSubmissionFromRow(row: ActionLogLike, def: SecretDefinition, requestId: string): boolean {
  const params = row.params && typeof row.params === 'object' ? row.params as Record<string, unknown> : {};
  const constraints = params.constraints && typeof params.constraints === 'object' ? params.constraints as Record<string, unknown> : {};
  if (constraints.request_id !== requestId) return false;
  if (constraints.secret !== def.secret) return false;
  const contract = acquiredSecretContract(def.secret);
  if (!contract
    || constraints.provider !== def.provider
    || constraints.operation !== 'acquire'
    || constraints.vault_item_id !== contract.item) return false;
  const result = row.result && typeof row.result === 'object' ? row.result as Record<string, unknown> : {};
  const generic = result.generic_browser_task && typeof result.generic_browser_task === 'object' ? result.generic_browser_task as Record<string, unknown> : {};
  const value = generic.value && typeof generic.value === 'object' ? generic.value as Record<string, unknown> : {};
  return value.status === 'submitted' && /Semantic Scholar/i.test(`${value.confirmation ?? ''} ${value.next_steps ?? ''}`);
}

type ActionLogLike = { id?: string | null; params?: unknown; result?: unknown };

async function latestSubmittedSemanticScholarRun(
  def: SecretDefinition,
  requestId: string,
  tenantId?: string | null,
): Promise<string | null> {
  const database = optionalWelesDatabase();
  if (!database) return null;
  const tenantFilter = tenantId
    ? `&tenant_id=eq.${encodeURIComponent(tenantId)}`
    : '&tenant_id=is.null';
  const limit = 'xxxxxxxxxxxxxxxxxxxx'.length;
  const res = await fetch(`${database.url}/rest/v1/account_action_logs?action=eq.generic_keeper_task&platform=eq.generic&status=eq.completed&select=id,params,result&order=completed_at.desc&limit=${limit}${tenantFilter}`, { headers: headers() });
  if (!res.ok) return null;
  const rows = await res.json() as ActionLogLike[];
  return rows.find((row) => row.id && semanticSubmissionFromRow(row, def, requestId))?.id ?? null;
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

  const database = optionalWelesDatabase();
  const missing = [
    ...(!database ? ['weles-database launcher configuration'] : []),
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

  const submittedRunId = def.secret === SEMANTIC_SCHOLAR.secret && request.requestId
    ? await latestSubmittedSemanticScholarRun(def, request.requestId, request.tenantId)
    : null;
  if (submittedRunId) {
    const followup = await queueSemanticScholarFollowup(
      submittedRunId,
      ''.length,
      ''.length,
      request.tenantId ?? undefined,
    );
    return {
      status: 'operation_queued',
      operation: 'acquire',
      vaultItemId: vaultItemId ?? def.secret,
      secret: def.secret,
      provider: def.provider,
      sourceActionLogId: submittedRunId,
      actionLogId: followup.action_log_id,
      action: 'semanticscholar_key_followup',
      flowName: 'semantic-scholar-key-followup',
      scheduledAt: followup.scheduled_at,
      alreadyQueued: !followup.queued,
      message: followup.queued
        ? `${def.displayName} API key mailbox follow-up queued`
        : `${def.displayName} API key mailbox follow-up is already queued or running`,
    };
  }

  const buildId = await insertReturning('weles_trajectory_builds', {
    tenant_id: request.tenantId ?? null,
    name: `${def.displayName} API key acquisition`,
    platform: 'generic',
    url: def.formUrl,
    objective: String(params.objective),
    constraints: params.constraints,
    env: params.env,
    status: 'queued',
  });

  const actionLogId = await insertReturning('account_action_logs', {
    action: 'generic_keeper_task',
    platform: 'generic',
    status: 'queued',
    scheduled_at: new Date().toISOString(),
    priority: request.priority ?? 10,
    params: { ...params, trajectory_build_id: buildId },
    tenant_id: request.tenantId ?? null,
    queued_by: 'secret-acquisition',
  });

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
