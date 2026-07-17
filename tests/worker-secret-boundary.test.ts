import type { SpawnOptions } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { acquireSecret } from '../src/secrets/acquire.js';

const mocks = vi.hoisted(() => {
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = 'https://supabase.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.SUPABASE_DB_URL = 'postgres://worker:test@db.example.test/postgres';
  process.env.WELES_WORKER_FORCE_ENABLED = '1';

  return {
    originalEnv,
    claimOne: vi.fn(),
    execSync: vi.fn(),
    fetchRequests: [] as Array<{ url: string; init?: RequestInit }>,
    readFile: vi.fn(),
    readdir: vi.fn(),
    spawn: vi.fn(),
    sql: Object.assign(vi.fn(), { end: vi.fn() }),
    writeFile: vi.fn(),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: mocks.execSync,
    spawn: mocks.spawn,
  };
});

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  readdir: mocks.readdir,
  stat: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  writeFile: mocks.writeFile,
}));

vi.mock('postgres', () => ({
  default: vi.fn(() => mocks.sql),
}));

vi.mock('../src/worker/claim.js', () => ({ claimOne: mocks.claimOne }));
vi.mock('../src/worker/stale.js', () => ({ sweepZombiesIfDue: vi.fn() }));
vi.mock('../src/worker/stado-routing.js', () => ({
  loadWelesPolicy: vi.fn().mockResolvedValue({ enabled: true, actions: ['*'], wildcard: true }),
}));
vi.mock('../src/worker/dispatch.js', () => ({
  paramsToEnv: vi.fn(() => ({})),
  resolveTrajectory: vi.fn(() => 'scripts/trajectories/generic/keeper_task.mjs'),
}));
vi.mock('../src/worker/upload-artifacts.js', () => ({ uploadArtifacts: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/worker/verification.js', () => ({ verifyRunArtifacts: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/diagnostics/versions.js', () => ({ captureVersions: vi.fn(() => ({ weles_dirty: false, trajectory_file_dirty: false })) }));
vi.mock('../src/diagnostics/run-import.js', () => ({
  importRunProvenance: vi.fn().mockResolvedValue({}),
  pgConnectionString: vi.fn(() => 'postgres://worker:test@db.example.test/postgres'),
  writeNetworkCapture: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/utils/credentials.js', () => ({ platformAdminSessionReady: vi.fn() }));
vi.mock('../src/proxy/capability.js', () => ({ recordOutcome: vi.fn() }));

import { pollOnce } from '../src/worker/poll.js';

const secret = 's2-runtime-plaintext-7Hk2Qp9L';
const runId = '11111111-1111-4111-8111-111111111111';
const genericResult = {
  status: 'completed',
  value: {
    status: 'key_visible',
    api_key: secret,
    nested: { confirmation: `Acquired ${secret}; do not persist ${secret}` },
  },
};

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...mocks.originalEnv };
});

describe('worker secret acquisition boundary', () => {
  it('redacts an acquired runtime_install secret without materializing it in files, launchctl, process.env, or persisted credential state', async () => {
    mocks.claimOne.mockResolvedValue({
      id: runId,
      account_id: null,
      action: 'generic_keeper_task',
      platform: 'generic',
      params: {
        constraints: {
          secret: 'semantic_scholar.api_key',
          store_secret_target: 'service_credentials',
          display_name: 'Semantic Scholar',
          env_var: 'SEMANTIC_SCHOLAR_API_KEY',
          runtime_install: true,
        },
      },
    });
    mocks.sql.mockResolvedValue([{ can: true }]);
    mocks.sql.end.mockResolvedValue(undefined);
    mocks.readdir.mockResolvedValue([{
      name: 'generic_task_result.json',
      isDirectory: () => false,
    }]);
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('generic_task_result.json')) return JSON.stringify(genericResult);
      throw new Error(`missing fixture ${path}`);
    });

    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    mocks.spawn.mockImplementation((_command: string, _args: string[], options: SpawnOptions) => {
      spawnedEnv = options.env;
      const child = {
        stderr: { on: vi.fn() },
        kill: vi.fn(),
        on: vi.fn(),
      };
      child.on.mockImplementation((event: string, listener: (code: number) => void) => {
        if (event === 'close') queueMicrotask(() => listener(0));
        return child;
      });
      return child;
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = { url: String(url), init };
      mocks.fetchRequests.push(request);
      if (request.url.includes('/rest/v1/service_credentials?display_name=')) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const envBeforePoll = { ...process.env };

    await expect(pollOnce()).resolves.toBe('claimed');

    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.execSync).not.toHaveBeenCalled();
    expect(process.env).toEqual(envBeforePoll);
    expect(Object.values(process.env)).not.toContain(secret);
    expect(process.env.SEMANTIC_SCHOLAR_API_KEY).toBeUndefined();
    expect(process.env.S2_API_KEY).toBeUndefined();
    expect(JSON.stringify(spawnedEnv)).not.toContain(secret);

    const credentialWrite = mocks.fetchRequests.find(({ url, init }) =>
      url === 'https://supabase.example.test/rest/v1/service_credentials' && init?.method === 'POST',
    );
    expect(credentialWrite).toBeDefined();
    const credentialBody = JSON.parse(String(credentialWrite?.init?.body)) as Record<string, unknown>;
    expect(credentialBody).toMatchObject({
      display_name: 'Semantic Scholar',
      api_key_env_var: 'SEMANTIC_SCHOLAR_API_KEY',
      api_key_preview: null,
      metadata: {
        source: 'weles_secret_acquisition',
        source_run_id: runId,
        key_field: 'api_key',
        runtime_env_installed: false,
      },
    });
    expect(JSON.stringify(credentialBody)).not.toContain(secret);
    expect(JSON.stringify(credentialBody)).not.toContain(secret.slice(0, 6));
    expect(credentialBody).not.toHaveProperty('api_key');

    const completedWrite = mocks.fetchRequests.find(({ url, init }) => {
      if (url !== `https://supabase.example.test/rest/v1/account_action_logs?id=eq.${runId}` || init?.method !== 'PATCH') return false;
      const body = JSON.parse(String(init.body)) as { status?: string };
      return body.status === 'completed';
    });
    expect(completedWrite).toBeDefined();
    const completedBody = JSON.parse(String(completedWrite?.init?.body)) as {
      result: { generic_browser_task: typeof genericResult };
    };
    expect(JSON.stringify(completedBody)).not.toContain(secret);
    expect(completedBody.result.generic_browser_task.value.api_key).toBe('[redacted]');
    expect(completedBody.result.generic_browser_task.value.nested.confirmation).toBe(
      'Acquired [redacted]; do not persist [redacted]',
    );
  });

  it('binds Brave credential capture to the requested vault item and provider origin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const planned = await acquireSecret({
      secret: 'brave.search_api_key',
      dryRun: true,
      skarbiecRequestId: 'request-1',
      skarbiecCredentialId: 'BRAVE_SEARCH_API_KEY',
    });
    expect(planned.status).toBe('acquisition_plan');
    if (planned.status !== 'acquisition_plan') throw new Error('expected acquisition plan');
    expect(planned.params.constraints).toMatchObject({
      store_secret_target: 'skarbiec',
      vault_item_id: 'BRAVE_SEARCH_API_KEY',
      expected_secret_prefix: 'BSAI',
      secret_source_origin: 'https://api-dashboard.search.brave.com',
      identity_platform: 'brave',
    });
  });
});
