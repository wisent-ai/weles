import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const callJedenMock = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    callJeden: callJedenMock,
  };
});
import { shouldVerifyRun, verifyRunArtifacts } from '../src/worker/verification.js';
import { buildDeploymentVersionValue, writeDeploymentVersion } from '../src/worker/deployment_version.js';
import type { ActionLogRow } from '../src/worker/poll.js';

const baseEnv = { ...process.env };
const fixedDeploymentNow = new Date('2026-07-04T12:34:56.789Z');

const versionProbe = {
  weles_pkg_version: '0.4.0',
  weles_commit: '0123456789abcdef0123456789abcdef01234567',
  weles_commit_short: '0123456',
  weles_branch: 'main',
  weles_dirty: false,
  weles_dist_sha256: 'dist-sha',
  trajectories_tree_sha256: 'trajectories-sha',
  runner_entry_sha256: 'runner-sha',
  worker_started_at: '2026-07-04T12:00:00.000Z',
  recorded_at: '2026-07-04T12:00:01.000Z',
  worker_host: 'mac-mini-worker',
  worker_user: 'weles',
  node_version: 'v24.0.0',
  local_ip: '192.168.1.50',
  machine_id: 'secret-machine-id',
  dirty_diff: 'diff --git a/secret b/secret',
  nested: { local_ip: '10.0.0.5' },
};

function row(params: Record<string, unknown> = {}): ActionLogRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    account_id: null,
    action: 'generic_browser_task',
    platform: 'generic',
    params,
  };
}

beforeEach(() => {
  process.env.BRAMA_URL = 'https://router.example.test';
  process.env.WISENT_APP_AGENT_ID = 'agent-1';
  process.env.WISENT_APP_AGENT_AUTH_SECRET = 'secret';
  process.env.WELES_AGENT_MODEL = 'openai-primary';
  delete process.env.WELES_VERIFY_RUNS;
  callJedenMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...baseEnv };
});

describe('worker verification gate', () => {
  it('only gates promoted, build-test, or explicitly verified runs', () => {
    expect(shouldVerifyRun(row())).toBe(false);
    expect(shouldVerifyRun(row({ auto_promote_trajectory: true }))).toBe(true);
    expect(shouldVerifyRun(row({ build_test: true }))).toBe(true);
    expect(shouldVerifyRun(row({ verification_required: true }))).toBe(true);

    process.env.WELES_VERIFY_RUNS = '0';
    expect(shouldVerifyRun(row({ auto_promote_trajectory: true }))).toBe(false);
  });

  it('passes only explicit pass verdicts with sufficient confidence', async () => {
    callJedenMock.mockImplementationOnce(async (prompt: string) => {
      expect(prompt).toContain('https://storage.example/run/video.webm');
      expect(prompt).toContain('service_action');
      expect(prompt).toContain('Verify the target site serves the expected Umami script.');
      return {
        raw: JSON.stringify({
          verdict: 'pass',
          confidence: 0.84,
          reason: 'final page matches objective',
          evidence: ['video shows signed-in page'],
        }),
        model: 'openai-primary',
        routerUrl: 'https://router.example.test',
      };
    });

    const review = await verifyRunArtifacts(row({ auto_promote_trajectory: true, url: 'https://example.com', objective: 'Reach the signed-in page' }), {
      artifacts: { screenshots: [], videos: ['https://storage.example/run/video.webm'], video: 'https://storage.example/run/video.webm', dom: [], logs: [] },
      generic_browser_task: { final_url: 'https://example.com/home' },
      service_action: { action: 'umami_verify_tracking_script', objective: 'Verify the target site serves the expected Umami script.', url: 'https://example.com/', targetSite: { ok: true } },
      ban_signal: { healthy: true, signal: 'healthy' },
    });

    expect(review?.passed).toBe(true);
    expect(review?.verdict).toBe('pass');
    expect(review?.confidence).toBe(0.84);
    expect(callJedenMock).toHaveBeenCalledOnce();
  });

  it('holds uncertain or low-confidence reviews for pending review', async () => {
    callJedenMock.mockResolvedValueOnce({
      raw: '{"verdict":"pass","confidence":0.4,"reason":"weak evidence","evidence":[]}',
      model: 'openai-primary',
      routerUrl: 'https://router.example.test',
    });

    const review = await verifyRunArtifacts(row({ build_test: true }), { artifacts: { screenshots: [], videos: [], dom: [], logs: [] } });

    expect(review?.passed).toBe(false);
    expect(review?.verdict).toBe('pass');
    expect(review?.reason).toBe('weak evidence');
  });
});

describe('Weles deployment version heartbeat', () => {
  it('builds only the deployment fields safe for content-platform to expose', () => {
    const value = buildDeploymentVersionValue(versionProbe, fixedDeploymentNow, 'worker-instance-1');

    expect(value).toEqual({
      source: 'weles-worker',
      instance_id: 'worker-instance-1',
      updated_at: '2026-07-04T12:34:56.789Z',
      deployment: {
        weles_pkg_version: '0.4.0',
        weles_commit: '0123456789abcdef0123456789abcdef01234567',
        weles_commit_short: '0123456',
        weles_branch: 'main',
        weles_dirty: false,
        weles_dist_sha256: 'dist-sha',
        trajectories_tree_sha256: 'trajectories-sha',
        runner_entry_sha256: 'runner-sha',
        worker_started_at: '2026-07-04T12:00:00.000Z',
        recorded_at: '2026-07-04T12:00:01.000Z',
      },
      runner: {
        worker_host: 'mac-mini-worker',
        worker_user: 'weles',
        node_version: 'v24.0.0',
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
      },
    });

    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('192.168.1.50');
    expect(serialized).not.toContain('10.0.0.5');
    expect(serialized).not.toContain('secret-machine-id');
    expect(serialized).not.toContain('diff --git');
  });

  it('upserts the whitelisted value to the system_settings deployment key with service-role headers', async () => {
    const requests: Array<{ url: string; init?: RequestInit; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        init,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return new Response(null, { status: 204 });
    });

    const result = await writeDeploymentVersion({
      env: {
        SUPABASE_URL: 'https://supabase.example.test/',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
        WELES_INSTANCE_ID: 'mac-mini-a',
      },
      fetchImpl: fetchMock as typeof fetch,
      versions: versionProbe,
      now: fixedDeploymentNow,
    });

    expect(result).toMatchObject({ ok: true, status: 204 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://supabase.example.test/rest/v1/system_settings?on_conflict=key');
    expect(requests[0].init?.method).toBe('POST');
    expect(requests[0].init?.headers).toEqual({
      apikey: 'service-role-secret',
      Authorization: 'Bearer service-role-secret',
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    });
    expect(requests[0].body).toMatchObject({
      key: 'weles_deployment_version',
      value: result.value,
      updated_at: '2026-07-04T12:34:56.789Z',
    });
    expect(requests[0].body.value.instance_id).toBe('mac-mini-a');
    expect(requests[0].body.value.updated_at).toBe('2026-07-04T12:34:56.789Z');
    expect(JSON.stringify(requests[0].body)).not.toContain('secret-machine-id');
    expect(JSON.stringify(requests[0].body)).not.toContain('diff --git');
  });

  it('skips cleanly without touching the network when Supabase configuration is absent', async () => {
    const fetchMock = vi.fn();

    await expect(writeDeploymentVersion({
      env: {},
      fetchImpl: fetchMock as typeof fetch,
      versions: versionProbe,
      now: fixedDeploymentNow,
      instanceId: 'worker-instance-1',
    })).resolves.toEqual({ ok: false, skipped: 'missing_supabase_config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
