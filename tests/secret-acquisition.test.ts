import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireSecret, buildSecretAcquisitionPlan } from '../src/secrets/acquire.js';

const baseEnv = { ...process.env };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function expectPayloadOmitsDraftOnlyControlsAndGeneratedIdentity(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain('allow_submit');
  expect(serialized).not.toContain('do_not_submit_final_form');
  expect(serialized).not.toContain('do_not_accept_legal_terms');
  expect(serialized).not.toContain('identity_policy');
  expect(serialized).not.toContain('trajectory_writer');
  expect(serialized).not.toContain('firstName');
  expect(serialized).not.toContain('lastName');
  expect(serialized).not.toContain('password');
  expect(serialized).not.toContain('rotated.example.test');
}

beforeEach(() => {
  process.env = { ...baseEnv };
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.S2_API_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...baseEnv };
});

describe('secret acquisition', () => {
  it('resolves a natural-language Semantic Scholar goal into a model-routed browser acquisition plan', () => {
    const result = buildSecretAcquisitionPlan({
      goal: 'daj mi klucz do Semantic Scholara dla LEM',
      dryRun: true,
    });

    expect(result.status).toBe('acquisition_plan');
    if (result.status !== 'acquisition_plan') return;
    expect(result.secret).toBe('semantic_scholar.api_key');
    expect(result.provider).toBe('semantic_scholar');
    expect(result.url).toBe('https://www.semanticscholar.org/product/api#api-key-form');
    expect(result.objective).toContain('Acquire Semantic Scholar API access for lem.');
    expect(result.objective).toContain('Use Weles-generated or invented applicant details for identity, affiliation, organization, role, website, country, and other registration profile fields');
    expect(result.objective).toContain('do not ask the user for personal or organization data');
    expect(result.objective).not.toContain('Do not click final Submit');
    expect(result.params).toMatchObject({
      url: 'https://www.semanticscholar.org/product/api#api-key-form',
      flow_name: 'semantic-scholar-api-key-request',
      auto_promote_trajectory: true,
      constraints: {
        secret: 'semantic_scholar.api_key',
        purpose: 'lem',
        store_secret_target: 'service_credentials',
        display_name: 'Semantic Scholar',
        env_var: 'SEMANTIC_SCHOLAR_API_KEY',
      },
    });
    expectPayloadOmitsDraftOnlyControlsAndGeneratedIdentity(result.params);
  });

  it('validates an existing env key against Semantic Scholar without enqueueing Supabase rows', async () => {
    process.env.SEMANTIC_SCHOLAR_API_KEY = 's2-test-key';
    process.env.SUPABASE_URL = 'https://supabase.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.semanticscholar.org/graph/v1/paper/search?query=test&limit=1&fields=title');
      expect(init?.method).toBeUndefined();
      expect(init?.headers).toEqual({ 'x-api-key': 's2-test-key' });
      return jsonResponse({ data: [{ title: 'test paper' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await acquireSecret({ secret: 'semantic_scholar.api_key', purpose: 'lem' });

    expect(result).toEqual({
      status: 'existing_secret_found',
      secret: 'semantic_scholar.api_key',
      provider: 'semantic_scholar',
      source: 'env',
      envVar: 'SEMANTIC_SCHOLAR_API_KEY',
      validated: true,
      validationStatus: 'HTTP 200',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports missing Supabase configuration when no Semantic Scholar key is available', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await acquireSecret({ secret: 'semantic_scholar.api_key', purpose: 'lem' });

    expect(result).toEqual({
      status: 'needs_configuration',
      secret: 'semantic_scholar.api_key',
      provider: 'semantic_scholar',
      missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
      message: 'Cannot enqueue Weles acquisition without SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queues a Semantic Scholar acquisition build and keeper-first action log through Supabase', async () => {
    process.env.SUPABASE_URL = 'https://supabase.example.test/';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    const requests: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url: String(url), init, body });
      if (String(url).includes('/rest/v1/service_credentials')) return jsonResponse([]);
      if (String(url).includes('/rest/v1/weles_trajectory_builds')) return jsonResponse([{ id: 'build-123' }], 201);
      if (String(url).includes('/rest/v1/account_action_logs')) return jsonResponse([{ id: 'log-456' }], 201);
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await acquireSecret({ secret: 'semantic_scholar.api_key', purpose: 'lem', tenantId: 'tenant-1' });

    expect(result).toEqual({
      status: 'acquisition_queued',
      secret: 'semantic_scholar.api_key',
      provider: 'semantic_scholar',
      buildId: 'build-123',
      actionLogId: 'log-456',
      action: 'generic_keeper_task',
      flowName: 'semantic-scholar-api-key-request',
      message: 'Semantic Scholar API key acquisition queued via generic_keeper_task',
    });
    expect(requests.map((request) => request.url)).toEqual([
      'https://supabase.example.test/rest/v1/service_credentials?select=id,display_name,category,api_key_env_var,api_key_preview,notes',
      'https://supabase.example.test/rest/v1/weles_trajectory_builds?select=id',
      'https://supabase.example.test/rest/v1/account_action_logs?select=id',
    ]);

    const buildInsert = requests[1];
    expect(buildInsert.init?.method).toBe('POST');
    expect(buildInsert.init?.headers).toMatchObject({
      apikey: 'service-role-key',
      Authorization: 'Bearer service-role-key',
      Prefer: 'return=representation',
    });
    expect(buildInsert.body).toMatchObject({
      tenant_id: 'tenant-1',
      name: 'Semantic Scholar API key acquisition',
      platform: 'generic',
      url: 'https://www.semanticscholar.org/product/api#api-key-form',
      status: 'queued',
    });
    expect(buildInsert.body?.objective).toEqual(expect.stringContaining('Semantic Scholar API access'));
    expect(buildInsert.body?.objective).toEqual(expect.stringContaining('Weles-generated or invented applicant details'));
    expect(buildInsert.body?.objective).toEqual(expect.stringContaining('do not ask the user for personal or organization data'));
    expect(buildInsert.body?.constraints).toEqual(expect.any(Object));
    expect(buildInsert.body?.constraints).not.toHaveProperty('identity_policy');
    expect(buildInsert.body?.constraints).not.toHaveProperty('trajectory_writer');
    expectPayloadOmitsDraftOnlyControlsAndGeneratedIdentity(buildInsert.body);

    const actionLogInsert = requests[2];
    expect(actionLogInsert.init?.method).toBe('POST');
    expect(actionLogInsert.body).toMatchObject({
      action: 'generic_keeper_task',
      platform: 'generic',
      status: 'queued',
      priority: 10,
      tenant_id: 'tenant-1',
      queued_by: 'secret-acquisition',
      params: {
        trajectory_build_id: 'build-123',
        auto_promote_trajectory: true,
        execution_mode: 'keeper_first',
        objective: expect.stringContaining('Semantic Scholar API access'),
      },
    });
    expect(actionLogInsert.body).not.toHaveProperty('max_steps');
    const actionParams = actionLogInsert.body?.params && typeof actionLogInsert.body.params === 'object'
      ? (actionLogInsert.body.params as Record<string, unknown>)
      : undefined;
    expect(actionParams).toEqual(expect.any(Object));
    expect(actionParams).not.toHaveProperty('max_steps');
    const actionConstraints = actionParams?.constraints;
    expect(actionConstraints).toEqual(expect.any(Object));
    expect(actionConstraints).not.toHaveProperty('identity_policy');
    expect(actionConstraints).not.toHaveProperty('trajectory_writer');
    expectPayloadOmitsDraftOnlyControlsAndGeneratedIdentity(actionLogInsert.body);
  });
});
