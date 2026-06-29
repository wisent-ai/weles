import { describe, expect, it, vi, afterEach } from 'vitest';
import { callModelRouter } from '../src/agent/loop.js';

describe('agent loop model router', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MODEL_ROUTER_URL;
    delete process.env.WISENT_APP_AGENT_ID;
    delete process.env.WISENT_APP_AGENT_AUTH_SECRET;
    delete process.env.WELES_AGENT_MODEL;
  });

  it('posts browser-agent prompts through the signed model-router API', async () => {
    process.env.MODEL_ROUTER_URL = 'https://router.example.test/';
    process.env.WISENT_APP_AGENT_ID = 'agent-test';
    process.env.WISENT_APP_AGENT_AUTH_SECRET = 'secret-test';
    process.env.WELES_AGENT_MODEL = 'claude-code-subscription';

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://router.example.test/v1/chat/completions');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-agent-id']).toBe('agent-test');
      expect(headers['x-agent-timestamp']).toMatch(/^\d+$/);
      expect(headers['x-agent-signature']).toMatch(/^[0-9a-f]{64}$/);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('claude-code-subscription');
      expect(body.messages).toEqual([{ role: 'user', content: 'choose next browser action' }]);
      return new Response(JSON.stringify({
        model: 'claude-code-subscription',
        choices: [{ message: { content: '{"tool":"done","args":{"value":"ok"}}' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callModelRouter('choose next browser action');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      raw: '{"tool":"done","args":{"value":"ok"}}',
      model: 'claude-code-subscription',
      routerUrl: 'https://router.example.test',
    });
  });
});
