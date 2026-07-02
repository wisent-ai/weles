type SecretDefinition = {
  secret: string;
  provider: string;
  displayName: string;
  envVars: string[];
  defaultPurpose: string;
  formUrl: string;
  flowName: string;
  serviceCredentialNames: string[];
  endpoints: string[];
  usageText: string;
  dailyRequests: string;
  validationUrl: string;
};

type ServiceCredentialRow = {
  id?: string | null;
  display_name?: string | null;
  category?: string | null;
  api_key_env_var?: string | null;
  api_key_preview?: string | null;
  notes?: string | null;
};

type InsertedId = { id: string };

export type AcquireSecretRequest = {
  goal?: string;
  secret?: string;
  purpose?: string;
  dryRun?: boolean;
  autoPromoteTrajectory?: boolean;
  proxy?: string;
  headless?: boolean;
  priority?: number;
  tenantId?: string | null;
};

export type AcquireSecretResult =
  | {
      status: 'existing_secret_found';
      secret: string;
      provider: string;
      source: 'env' | 'service_credentials_env' | 'service_credentials_reference';
      envVar?: string;
      serviceCredentialId?: string;
      displayName?: string;
      validated: boolean | null;
      validationStatus: string;
    }
  | {
      status: 'acquisition_plan';
      secret: string;
      provider: string;
      url: string;
      objective: string;
      params: Record<string, unknown>;
    }
  | {
      status: 'acquisition_queued';
      secret: string;
      provider: string;
      buildId: string;
      actionLogId: string;
      action: 'generic_keeper_task';
      flowName: string;
      message: string;
    }
  | {
      status: 'needs_configuration';
      secret: string;
      provider: string;
      missing: string[];
      message: string;
    }
  | {
      status: 'unsupported_secret';
      secret: string;
      message: string;
    };

const SEMANTIC_SCHOLAR: SecretDefinition = {
  secret: 'semantic_scholar.api_key',
  provider: 'semantic_scholar',
  displayName: 'Semantic Scholar',
  envVars: ['SEMANTIC_SCHOLAR_API_KEY', 'S2_API_KEY'],
  defaultPurpose: 'lem',
  formUrl: 'https://www.semanticscholar.org/product/api#api-key-form',
  flowName: 'semantic-scholar-api-key-request',
  serviceCredentialNames: ['semantic scholar', 'semantic-scholar', 's2'],
  endpoints: ['/graph/v1/paper/search', '/graph/v1/paper/{paper_id}', '/graph/v1/author/search'],
  usageText: 'We use the Semantic Scholar Academic Graph API to retrieve paper metadata, abstracts, authors, venues, citation counts, identifiers, and related-paper signals for a local research-paper assistant. Requests are used for indexing and contextualizing academic papers selected by the user, not for bulk redistribution.',
  dailyRequests: '1000',
  validationUrl: 'https://api.semanticscholar.org/graph/v1/paper/search?query=test&limit=1&fields=title',
};

const SECRET_REGISTRY: Record<string, SecretDefinition> = {
  [SEMANTIC_SCHOLAR.secret]: SEMANTIC_SCHOLAR,
  semantic_scholar_api_key: SEMANTIC_SCHOLAR,
  semantic_scholar: SEMANTIC_SCHOLAR,
  s2_api_key: SEMANTIC_SCHOLAR,
};

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

function normalizeSecret(request: AcquireSecretRequest): string {
  const explicit = request.secret?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (explicit) return explicit.includes('.') ? explicit.replace(/_/g, '_') : explicit;
  const goal = request.goal?.toLowerCase() ?? '';
  if ((goal.includes('semantic') && goal.includes('scholar')) || goal.includes('semanticscholar') || goal.includes('s2')) {
    return SEMANTIC_SCHOLAR.secret;
  }
  return '';
}

function definitionFor(request: AcquireSecretRequest): SecretDefinition | null {
  const normalized = normalizeSecret(request);
  if (!normalized) return null;
  return SECRET_REGISTRY[normalized] ?? SECRET_REGISTRY[normalized.replace(/\./g, '_')] ?? null;
}

function headers(): Record<string, string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function serviceCredentialRows(): Promise<ServiceCredentialRow[]> {
  const supabaseUrl = env('SUPABASE_URL') || env('NEXT_PUBLIC_SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!supabaseUrl || !key) return [];
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/service_credentials?select=id,display_name,category,api_key_env_var,api_key_preview,notes`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];
  return await res.json() as ServiceCredentialRow[];
}

async function validateKey(def: SecretDefinition, key: string): Promise<{ validated: boolean; status: string }> {
  try {
    const res = await fetch(def.validationUrl, { headers: { 'x-api-key': key } });
    if (res.ok) return { validated: true, status: `HTTP ${res.status}` };
    return { validated: false, status: `HTTP ${res.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { validated: false, status: `validation error: ${message.slice(0, 160)}` };
  }
}

async function existingSecret(def: SecretDefinition): Promise<AcquireSecretResult | null> {
  for (const envVar of def.envVars) {
    const key = env(envVar);
    if (!key) continue;
    const validation = await validateKey(def, key);
    return {
      status: 'existing_secret_found',
      secret: def.secret,
      provider: def.provider,
      source: 'env',
      envVar,
      validated: validation.validated,
      validationStatus: validation.status,
    };
  }

  const names = new Set(def.serviceCredentialNames.map((name) => name.toLowerCase()));
  for (const row of await serviceCredentialRows()) {
    const display = (row.display_name ?? '').toLowerCase();
    const envVar = row.api_key_env_var ?? undefined;
    const matchesName = [...names].some((name) => display.includes(name));
    const matchesEnv = !!envVar && def.envVars.includes(envVar);
    if (!matchesName && !matchesEnv) continue;
    if (envVar && env(envVar)) {
      const validation = await validateKey(def, env(envVar));
      return {
        status: 'existing_secret_found',
        secret: def.secret,
        provider: def.provider,
        source: 'service_credentials_env',
        envVar,
        serviceCredentialId: row.id ?? undefined,
        displayName: row.display_name ?? undefined,
        validated: validation.validated,
        validationStatus: validation.status,
      };
    }
    if (row.api_key_preview) {
      return {
        status: 'existing_secret_found',
        secret: def.secret,
        provider: def.provider,
        source: 'service_credentials_reference',
        envVar,
        serviceCredentialId: row.id ?? undefined,
        displayName: row.display_name ?? undefined,
        validated: null,
        validationStatus: 'secret reference exists but plaintext is not available to this process',
      };
    }
  }
  return null;
}

function purposeFor(request: AcquireSecretRequest, def: SecretDefinition): string {
  const purpose = request.purpose?.trim();
  if (purpose) return purpose;
  const goal = request.goal?.toLowerCase() ?? '';
  if (goal.includes('lem')) return 'lem';
  return def.defaultPurpose;
}

function objectiveFor(def: SecretDefinition, request: AcquireSecretRequest): string {
  const purpose = purposeFor(request, def);
  const mode = 'Submit the request after all required fields are filled. Use Weles-generated or invented applicant details for identity, affiliation, organization, role, website, country, and other registration profile fields; do not ask the user for personal or organization data. Return the final confirmation state, any issued key-delivery instructions, and any next-step instructions. If mailbox access or CAPTCHA cannot be completed, stop and return needs_human_approval.';
  return [
    `Acquire ${def.displayName} API access for ${purpose}.`,
    `Use case: ${def.usageText}`,
    `Requested endpoints: ${def.endpoints.join(', ')}.`,
    `Expected daily requests: ${def.dailyRequests}.`,
    mode,
  ].join(' ');
}

function paramsFor(def: SecretDefinition, request: AcquireSecretRequest): Record<string, unknown> {
  const autoPromote = request.autoPromoteTrajectory !== false;
  const flowName = def.flowName;
  return {
    url: def.formUrl,
    objective: objectiveFor(def, request),
    flow_name: flowName,
    execution_mode: 'keeper_first',
    proxy: request.proxy ?? 'none',
    headless: request.headless === true,
    auto_promote_trajectory: autoPromote,
    constraints: {
      secret: def.secret,
      purpose: purposeFor(request, def),
      store_secret_target: 'service_credentials',
      display_name: def.displayName,
      env_var: def.envVars[0],
      requested_endpoints: def.endpoints,
      expected_daily_requests: def.dailyRequests,
    },
    env: {},
  };
}

async function insertReturning(table: string, row: Record<string, unknown>): Promise<string> {
  const supabaseUrl = env('SUPABASE_URL') || env('NEXT_PUBLIC_SUPABASE_URL');
  const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}?select=id`, {
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

async function queueAcquisition(def: SecretDefinition, request: AcquireSecretRequest): Promise<AcquireSecretResult> {
  const params = paramsFor(def, request);
  if (request.dryRun === true) {
    return {
      status: 'acquisition_plan',
      secret: def.secret,
      provider: def.provider,
      url: def.formUrl,
      objective: String(params.objective),
      params,
    };
  }

  const supabaseUrl = env('SUPABASE_URL') || env('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    return {
      status: 'needs_configuration',
      secret: def.secret,
      provider: def.provider,
      missing,
      message: `Cannot enqueue Weles acquisition without ${missing.join(', ')}`,
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
    status: 'acquisition_queued',
    secret: def.secret,
    provider: def.provider,
    buildId,
    actionLogId,
    action: 'generic_keeper_task',
    flowName: def.flowName,
    message: `${def.displayName} API key acquisition queued via generic_keeper_task`,
  };
}

export async function acquireSecret(request: AcquireSecretRequest): Promise<AcquireSecretResult> {
  const def = definitionFor(request);
  if (!def) {
    const secret = normalizeSecret(request) || 'unknown';
    return { status: 'unsupported_secret', secret, message: `No secret acquisition registry entry for ${secret}` };
  }

  const existing = await existingSecret(def);
  if (existing) return existing;
  return queueAcquisition(def, request);
}

export function buildSecretAcquisitionPlan(request: AcquireSecretRequest): AcquireSecretResult {
  const def = definitionFor(request);
  if (!def) {
    const secret = normalizeSecret(request) || 'unknown';
    return { status: 'unsupported_secret', secret, message: `No secret acquisition registry entry for ${secret}` };
  }
  const params = paramsFor(def, { ...request, dryRun: true });
  return {
    status: 'acquisition_plan',
    secret: def.secret,
    provider: def.provider,
    url: def.formUrl,
    objective: String(params.objective),
    params,
  };
}
