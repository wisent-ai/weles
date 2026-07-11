import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { claimOne } from '../src/worker/claim.js';
import { normalizeHostname } from '../src/worker/identity.js';
import {
  loadWelesPolicy,
  parseStadoRegistry,
  resolveWelesPolicy,
  type WelesActionPolicy,
} from '../src/worker/stado-routing.js';

const baseEnv = { ...process.env };

function localTarget(overrides: Record<string, unknown> = {}) {
  return {
    name: 'mac-mini-a',
    kind: 'local',
    hostnames: ['mac-mini-a.local'],
    weles: { enabled: true, actions: ['generic_browser_task'] },
    ...overrides,
  };
}

function registry(...targets: Array<Record<string, unknown>>) {
  return { schema_version: 2, targets };
}

beforeEach(() => {
  execFileMock.mockReset();
  delete process.env.WELES_STADO_ROUTING;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...baseEnv };
});

describe('Stado host routing', () => {
  it.each([
    { identity: '  MAC-MINI-A...  ', expected: 'mac-mini-a' },
    { identity: 'Mac-Mini-A.Local.', expected: 'mac-mini-a.local' },
  ])('normalizes hostname case, surrounding space, and trailing dots for $identity', ({ identity, expected }) => {
    expect(normalizeHostname(identity)).toBe(expected);
  });

  it.each([
    { name: 'canonical target name', hostname: 'MAC-MINI-A.' },
    { name: 'explicit alias', hostname: '  MAC-MINI-A.LOCAL. ' },
    { name: 'legacy SSH hostname', hostname: 'BUILDER.EXAMPLE.' },
  ])('resolves the policy through the $name', ({ hostname }) => {
    const parsed = parseStadoRegistry(registry(localTarget({ ssh: 'weles@Builder.Example.:22' })));

    expect(resolveWelesPolicy(parsed, hostname)).toEqual({
      enabled: true,
      actions: ['generic_browser_task'],
      wildcard: false,
    });
  });

  it('denies a hostname absent from the registry', () => {
    const parsed = parseStadoRegistry(registry(localTarget()));

    expect(resolveWelesPolicy(parsed, 'other-host')).toEqual({
      enabled: false,
      actions: [],
      wildcard: false,
    });
  });

  it('never routes Weles work to a matching non-local target', () => {
    const parsed = parseStadoRegistry(registry({
      name: 'cloud-runner',
      kind: 'gcp',
      hostnames: ['mac-mini-a.local'],
    }));

    expect(resolveWelesPolicy(parsed, 'MAC-MINI-A.LOCAL.')).toEqual({
      enabled: false,
      actions: [],
      wildcard: false,
    });
  });

  it.each([
    {
      name: 'alias collides with another target name after normalization',
      targets: [
        localTarget({ name: 'mac-mini-a', hostnames: [] }),
        localTarget({ name: 'mac-mini-b', hostnames: ['MAC-MINI-A.'] }),
      ],
    },
    {
      name: 'SSH hostname collides with an alias after normalization',
      targets: [
        localTarget({ name: 'mac-mini-a', hostnames: ['builder.example'] }),
        localTarget({ name: 'mac-mini-b', hostnames: [], ssh: 'weles@BUILDER.EXAMPLE.' }),
      ],
    },
  ])('rejects duplicate normalized host identity when $name', ({ targets }) => {
    expect(() => parseStadoRegistry(registry(...targets))).toThrow(/identity|unique|duplicate/i);
  });
});

describe('Stado registry policy validation', () => {
  it.each([
    { name: 'exact lowercase action', actions: ['generic_browser_task'], wildcard: false },
    { name: 'sole wildcard', actions: ['*'], wildcard: true },
  ])('accepts $name', ({ actions, wildcard }) => {
    const parsed = parseStadoRegistry(registry(localTarget({
      weles: { enabled: true, actions },
    })));

    expect(resolveWelesPolicy(parsed, 'mac-mini-a')).toEqual({ enabled: true, actions, wildcard });
  });

  it.each([
    { name: 'uppercase action', actions: ['Generic_Browser_Task'] },
    { name: 'surrounding whitespace', actions: [' generic_browser_task'] },
    { name: 'punctuated action', actions: ['generic-browser-task'] },
    { name: 'duplicate action', actions: ['github_star', 'github_star'] },
    { name: 'wildcard mixed with an exact action', actions: ['*', 'github_star'] },
  ])('rejects $name', ({ actions }) => {
    expect(() => parseStadoRegistry(registry(localTarget({
      weles: { enabled: true, actions },
    })))).toThrow();
  });

  it.each([
    { schema_version: 1, targets: [] },
    { schema_version: true, targets: [] },
    { schema_version: 2, targets: {} },
    null,
  ])('rejects an invalid registry document %#', (document) => {
    expect(() => parseStadoRegistry(document)).toThrow();
  });

  it('rejects a Weles policy attached to a non-local target', () => {
    expect(() => parseStadoRegistry(registry(localTarget({ kind: 'gcp' })))).toThrow(/only valid for kind=local/);
  });
});

describe('routing modes', () => {
  it('off mode permits all actions without fetching the registry', async () => {
    process.env.WELES_STADO_ROUTING = 'off';

    await expect(loadWelesPolicy()).resolves.toEqual({
      enabled: true,
      actions: ['*'],
      wildcard: true,
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('required mode fails closed when the registry cannot be fetched', async () => {
    process.env.WELES_STADO_ROUTING = 'required';
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
    ) => callback(Object.assign(new Error('gcloud unavailable'), { code: 'ENOENT' }), '', ''));

    await expect(loadWelesPolicy()).rejects.toThrow('Stado registry fetch failed');
  });

  it('rejects unknown and case-variant modes without fetching the registry', async () => {
    process.env.WELES_STADO_ROUTING = 'OFF';

    await expect(loadWelesPolicy()).rejects.toThrow('WELES_STADO_ROUTING must be required or off');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('conditional Supabase claim defense', () => {
  it('does not claim a row returned outside the exact action allowlist', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET' });
      if (requests.length > 1) throw new Error('disallowed row reached a claim request');
      return new Response(JSON.stringify([{
        id: '11111111-1111-4111-8111-111111111111',
        account_id: null,
        action: 'generic_browser_task',
        platform: 'generic',
        params: {},
        status: 'queued',
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const policy: WelesActionPolicy = {
      enabled: true,
      actions: ['github_star'],
      wildcard: false,
    };

    await expect(claimOne(policy)).resolves.toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
  });
});
