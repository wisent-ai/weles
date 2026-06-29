import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldVerifyRun, verifyRunArtifacts } from '../src/worker/verification.js';
import type { ActionLogRow } from '../src/worker/poll.js';

const baseEnv = { ...process.env };

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
  process.env.MODEL_ROUTER_URL = 'https://router.example.test';
  process.env.WISENT_APP_AGENT_ID = 'agent-1';
  process.env.WISENT_APP_AGENT_AUTH_SECRET = 'secret';
  process.env.WELES_AGENT_MODEL = 'claude-code-subscription';
  delete process.env.WELES_VERIFY_RUNS;
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
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://router.example.test/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('claude-code-subscription');
      expect(body.messages[0].content).toContain('https://storage.example/run/video.webm');
      expect(body.messages[0].content).toContain('service_action');
      expect(body.messages[0].content).toContain('Verify the target site serves the expected Umami script.');
      return new Response(JSON.stringify({
        model: 'claude-code-subscription',
        choices: [{ message: { content: JSON.stringify({ verdict: 'pass', confidence: 0.84, reason: 'final page matches objective', evidence: ['video shows signed-in page'] }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const review = await verifyRunArtifacts(row({ auto_promote_trajectory: true, url: 'https://example.com', objective: 'Reach the signed-in page' }), {
      artifacts: { screenshots: [], videos: ['https://storage.example/run/video.webm'], video: 'https://storage.example/run/video.webm', dom: [], logs: [] },
      generic_browser_task: { final_url: 'https://example.com/home' },
      service_action: { action: 'umami_verify_tracking_script', objective: 'Verify the target site serves the expected Umami script.', url: 'https://example.com/', targetSite: { ok: true } },
      ban_signal: { healthy: true, signal: 'healthy' },
    });

    expect(review?.passed).toBe(true);
    expect(review?.verdict).toBe('pass');
    expect(review?.confidence).toBe(0.84);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('holds uncertain or low-confidence reviews for pending review', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"verdict":"pass","confidence":0.4,"reason":"weak evidence","evidence":[]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const review = await verifyRunArtifacts(row({ build_test: true }), { artifacts: { screenshots: [], videos: [], dom: [], logs: [] } });

    expect(review?.passed).toBe(false);
    expect(review?.verdict).toBe('pass');
    expect(review?.reason).toBe('weak evidence');
  });
});
