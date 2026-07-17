import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execute } from '../src/agent/loop.js';
import { dispatch } from '../src/agent/tools.js';
import type { WSession } from '../src/session/wsession.js';

const CAPABILITY = {
  capability_id: 'a'.repeat(64),
  purpose: 'weles.browser.fill',
  resource: 'origin:https://accounts.example.test/password',
  target: 'weles',
} as const;

function dispatchSession() {
  return {
    fillCredential: vi.fn(async () => 'credential filled'),
    fillIdentity: vi.fn(async () => 'identity filled'),
    fill: vi.fn(async (_target: string, _value: string) => 'literal filled'),
    type: vi.fn(async (_value: string) => 'literal typed'),
    resolveEnv: vi.fn(() => { throw new Error('generic input must not resolve environment variables'); }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('agent capability dispatch', () => {
  it('dispatches fill_credential with the exact selector, field class, and typed Weles reference', async () => {
    const session = dispatchSession();

    const result = await dispatch(session as unknown as WSession, 'fill_credential', {
      target: 'Account password',
      field_class: 'password',
      capability: CAPABILITY,
    });

    expect(result).toBe('credential filled');
    expect(session.fillCredential).toHaveBeenCalledOnce();
    expect(session.fillCredential).toHaveBeenCalledWith('Account password', 'password', CAPABILITY);
    expect(session.fill).not.toHaveBeenCalled();
    expect(session.type).not.toHaveBeenCalled();
    expect(session.resolveEnv).not.toHaveBeenCalled();
  });

  it('fills a generated identity field without passing its plaintext through tool arguments', async () => {
    const session = dispatchSession();

    const result = await dispatch(session as unknown as WSession, 'fill_identity', {
      target: 'Email address',
      field: 'email',
    });

    expect(result).toBe('identity filled');
    expect(session.fillIdentity).toHaveBeenCalledOnce();
    expect(session.fillIdentity).toHaveBeenCalledWith('Email address', 'email');
    expect(session.fill).not.toHaveBeenCalled();
    expect(session.fillCredential).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'non-Weles target', capability: { ...CAPABILITY, target: 'most' } },
    { name: 'plaintext reference', capability: '$SECRET_ENV' },
    { name: 'reference carrying an extra plaintext field', capability: { ...CAPABILITY, secret: 'plaintext' } },
    { name: 'reference missing its resource', capability: { capability_id: CAPABILITY.capability_id, purpose: CAPABILITY.purpose, target: CAPABILITY.target } },
  ])('rejects $name before the credential consumer is reached', async ({ capability }) => {
    const session = dispatchSession();

    await expect(dispatch(session as unknown as WSession, 'fill_credential', {
      target: 'Account password',
      field_class: 'password',
      capability,
    })).rejects.toThrow('invalid capability reference');

    expect(session.fillCredential).not.toHaveBeenCalled();
  });

  it('rejects an untyped credential field before the credential consumer is reached', async () => {
    const session = dispatchSession();

    await expect(dispatch(session as unknown as WSession, 'fill_credential', {
      target: 'Account password',
      field_class: 'billing-address',
      capability: CAPABILITY,
    })).rejects.toThrow('invalid field_class');

    expect(session.fillCredential).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'Password', target: 'Password' },
    { name: 'API key', target: 'API key' },
    { name: 'token', target: 'Access token' },
    { name: 'secret', target: 'Client secret' },
    { name: 'credential', target: 'Service credential' },
  ])('rejects generic fill for a $name target before session.fill runs', async ({ target }) => {
    const session = dispatchSession();

    await expect(dispatch(session as unknown as WSession, 'fill', {
      target,
      value: 'benign literal',
    })).rejects.toThrow('credential fields require fill_credential with a capability reference');

    expect(session.fill).not.toHaveBeenCalled();
    expect(session.resolveEnv).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'fill with $NAME', tool: 'fill', args: { target: 'Display name', value: '$SUPABASE_SERVICE_ROLE_KEY' } },
    { name: 'fill with ${NAME}', tool: 'fill', args: { target: 'Display name', value: '${SUPABASE_SERVICE_ROLE_KEY}' } },
    { name: 'type_text with $NAME', tool: 'type_text', args: { value: '$SUPABASE_SERVICE_ROLE_KEY' } },
    { name: 'type_text with ${NAME}', tool: 'type_text', args: { value: '${SUPABASE_SERVICE_ROLE_KEY}' } },
  ])('rejects $name before a session input method runs', async ({ tool, args }) => {
    const session = dispatchSession();

    await expect(dispatch(session as unknown as WSession, tool, args))
      .rejects.toThrow('environment references are forbidden in model input; use a capability reference');

    expect(session.fill).not.toHaveBeenCalled();
    expect(session.type).not.toHaveBeenCalled();
    expect(session.resolveEnv).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'fill', tool: 'fill', args: { target: 'Display name', value: 'ghp_1234567890abcdefghijklmnop' } },
    { name: 'type_text', tool: 'type_text', args: { value: 'ghp_1234567890abcdefghijklmnop' } },
  ])('rejects a raw token-shaped value in generic $name before a session input method runs', async ({ tool, args }) => {
    const session = dispatchSession();

    await expect(dispatch(session as unknown as WSession, tool, args))
      .rejects.toThrow('secret-shaped values require fill_credential with a capability reference');

    expect(session.fill).not.toHaveBeenCalled();
    expect(session.type).not.toHaveBeenCalled();
    expect(session.resolveEnv).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'fill',
      tool: 'fill',
      args: { target: 'Display name', value: 'Ada Lovelace' },
      expected: ['Display name', 'Ada Lovelace'],
      result: 'literal filled',
    },
    {
      name: 'type_text',
      tool: 'type_text',
      args: { value: 'literal search query' },
      expected: ['literal search query'],
      result: 'literal typed',
    },
  ])('preserves literal non-secret input through generic $name', async ({ tool, args, expected, result }) => {
    const session = dispatchSession();

    await expect(dispatch(session as unknown as WSession, tool, args)).resolves.toBe(result);

    const inputMethod = tool === 'fill' ? session.fill : session.type;
    expect(inputMethod).toHaveBeenCalledOnce();
    expect(inputMethod).toHaveBeenCalledWith(...expected);
    expect(session.resolveEnv).not.toHaveBeenCalled();
  });

  it('exposes only env-hint keys and unavailable markers to model state, logs, and history', async () => {
    const envValue = 'model-must-never-see-this-secret';
    const runId = 'capability-dispatch-env-hints';
    const previousRouterUrl = process.env.BRAMA_URL;
    const previousAgentId = process.env.WISENT_APP_AGENT_ID;
    const previousAuthSecret = process.env.WISENT_APP_AGENT_AUTH_SECRET;
    const previousRunId = process.env.WELES_RUN_ID;
    process.env.BRAMA_URL = 'https://router.example.test';
    process.env.WISENT_APP_AGENT_ID = 'capability-dispatch-test';
    process.env.WISENT_APP_AGENT_AUTH_SECRET = 'router-auth-for-test';
    process.env.WELES_RUN_ID = runId;

    const frame = {
      evaluate: vi.fn(async () => ({ title: 'Login', text: 'Sign in', controls: [] })),
    };
    const page = {
      url: vi.fn(() => 'https://accounts.example.test/login'),
      screenshot: vi.fn(async () => Buffer.from('png')),
      mainFrame: vi.fn(() => frame),
      frames: vi.fn(() => [frame]),
      context: vi.fn(() => ({ pages: () => [page] })),
      isClosed: vi.fn(() => false),
    };
    const prompts: string[] = [];
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const session = {
      page,
      label: '',
      resolveEnv: vi.fn((value: string) => value),
    };

    try {
      const result = await execute(session as unknown as WSession, 'sign in', {
        envHints: { SECRET_ENV: envValue },
        modelDecision: async (prompt) => {
          prompts.push(prompt);
          return {
            raw: '{"tool":"done","args":{"value":"ok"}}',
            model: 'unit-test-model',
            routerUrl: 'https://router.example.test',
          };
        },
      });

      expect(result.value).toBe('ok');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('SECRET_ENV=[value unavailable to model]');
      expect(prompts[0]).not.toContain(envValue);
      expect(JSON.stringify(result.history)).not.toContain(envValue);
      const consoleOutput = consoleSpies.flatMap((spy) => spy.mock.calls).flat().map(String).join('\n');
      expect(consoleOutput).not.toContain(envValue);
    } finally {
      if (previousRouterUrl === undefined) delete process.env.BRAMA_URL;
      else process.env.BRAMA_URL = previousRouterUrl;
      if (previousAgentId === undefined) delete process.env.WISENT_APP_AGENT_ID;
      else process.env.WISENT_APP_AGENT_ID = previousAgentId;
      if (previousAuthSecret === undefined) delete process.env.WISENT_APP_AGENT_AUTH_SECRET;
      else process.env.WISENT_APP_AGENT_AUTH_SECRET = previousAuthSecret;
      if (previousRunId === undefined) delete process.env.WELES_RUN_ID;
      else process.env.WELES_RUN_ID = previousRunId;
      rmSync(join(process.cwd(), 'recordings', runId), { recursive: true, force: true });
    }
  });
});
