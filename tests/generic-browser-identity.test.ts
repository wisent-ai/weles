import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const generatedIdentity = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  username: 'adalovelace1843',
  email: 'adalovelace1843@rotated.example.test',
  password: 'Secret!2345a',
  birthMonth: 'December',
  birthDay: '10',
  birthYear: '1991',
};

const asyncNewBrowserMock = vi.hoisted(() => vi.fn());
const generateIdentityMock = vi.hoisted(() => vi.fn());
const generatePersonaMock = vi.hoisted(() => vi.fn());

vi.mock('../src/async_api.js', () => ({
  AsyncNewBrowser: asyncNewBrowserMock,
}));

vi.mock('../src/browser/persona.js', () => ({
  generatePersona: generatePersonaMock,
}));

vi.mock('../src/utils/identity.js', () => ({
  generateIdentity: generateIdentityMock,
}));

import { WSession } from '../src/session/wsession.js';

const baseEnv = { ...process.env };
const baseExitCode = process.exitCode;
let originalSigtermListeners: ReturnType<typeof process.listeners>;
let tempDirs: string[] = [];

function restoreEnv(): void {
  process.env = { ...baseEnv };
}

function removeAddedSigtermListeners(): void {
  const original = new Set(originalSigtermListeners);
  for (const listener of process.listeners('SIGTERM')) {
    if (!original.has(listener)) process.off('SIGTERM', listener);
  }
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeBrowserContext() {
  const page = {
    on: vi.fn(),
    url: vi.fn(() => 'https://www.semanticscholar.org/product/api#api-key-form'),
    goto: vi.fn(async () => undefined),
  };
  return {
    page,
    ctx: {
      pages: vi.fn(() => [page]),
      newPage: vi.fn(async () => page),
      on: vi.fn(),
      request: { get: vi.fn() },
      _welesFingerprintConfig: { navigator: 'test-fingerprint' },
      _welesBrowserProvenance: { provider: 'unit-test' },
    },
  };
}

class ProcessExit extends Error {
  constructor(readonly code: string | number | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

beforeEach(() => {
  originalSigtermListeners = process.listeners('SIGTERM');
  restoreEnv();
  process.env.WELES_NO_INSTRUMENT = '1';
  process.env.WELES_DISABLE_RECORDING = '1';
  asyncNewBrowserMock.mockReset();
  generateIdentityMock.mockReset();
  generatePersonaMock.mockReset();
  generateIdentityMock.mockResolvedValue(generatedIdentity);
  generatePersonaMock.mockReturnValue({
    os: 'macos',
    browser: 'firefox',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
});

afterEach(() => {
  vi.doUnmock('../dist/session/wsession.js');
  vi.doUnmock('../dist/agent/index.js');
  vi.doUnmock('../dist/session/run-recordings.js');
  vi.doUnmock('../../../dist/trajectories/writer.js');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeAddedSigtermListeners();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  process.exitCode = baseExitCode;
  restoreEnv();
});

describe('WSession platform identity', () => {
  it('start({ platform }) exposes the generated identity and resolves every registration placeholder', async () => {
    const { ctx } = fakeBrowserContext();
    asyncNewBrowserMock.mockResolvedValueOnce(ctx);

    const session = await WSession.start({ platform: 'semantic_scholar', proxy: 'none', browser: 'firefox', headless: true, record: false });

    expect(generateIdentityMock).toHaveBeenCalledWith('semantic_scholar');
    expect(session.identity).toEqual(generatedIdentity);
    expect(session.resolveEnv('$SEMANTIC_SCHOLAR_NEW_FIRSTNAME')).toBe('Ada');
    expect(session.resolveEnv('$SEMANTIC_SCHOLAR_NEW_LASTNAME')).toBe('Lovelace');
    expect(session.resolveEnv('$SEMANTIC_SCHOLAR_NEW_USERNAME')).toBe('adalovelace1843');
    expect(session.resolveEnv('$SEMANTIC_SCHOLAR_NEW_EMAIL')).toBe('adalovelace1843@rotated.example.test');
    expect(session.resolveEnv('$SEMANTIC_SCHOLAR_NEW_PASSWORD')).toBe('Secret!2345a');
    expect(session.resolveEnv('${SEMANTIC_SCHOLAR_NEW_BIRTHMONTH}')).toBe('December');
    expect(session.resolveEnv('${SEMANTIC_SCHOLAR_NEW_BIRTHDAY}')).toBe('10');
    expect(session.resolveEnv('${SEMANTIC_SCHOLAR_NEW_BIRTHYEAR}')).toBe('1991');
  });

  it('fails fast instead of typing unresolved generated identity placeholders', async () => {
    const { ctx } = fakeBrowserContext();
    asyncNewBrowserMock.mockResolvedValueOnce(ctx);

    const session = await WSession.start({ proxy: 'none', browser: 'firefox', headless: true, record: false });

    expect(() => session.resolveEnv('$SEMANTIC_SCHOLAR_NEW_EMAIL')).toThrow('unresolved generated identity placeholder');
  });
});

describe('generic browser task Semantic Scholar identity contract', () => {
  it('turns Semantic Scholar secret constraints into WSession platform identity and check_email goal instructions without leaking generated personal data to artifacts', async () => {
    const recordingsDir = makeTempDir('weles-generic-browser-task-');
    const startMock = vi.fn(async () => ({
      identity: generatedIdentity,
      goto: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      page: { url: vi.fn(() => 'https://www.semanticscholar.org/product/api#api-key-form') },
    }));
    const executeMock = vi.fn(async () => ({
      value: { status: 'request_submitted', next: 'wait_for_email' },
      history: [{ tool: 'done', value: { status: 'request_submitted' } }],
    }));
    const constraints = {
      secret: 'semantic_scholar.api_key',
      purpose: 'lem',
      store_secret_target: 'service_credentials',
      display_name: 'Semantic Scholar',
      env_var: 'SEMANTIC_SCHOLAR_API_KEY',
    };
    const envHints = {
      SEMANTIC_SCHOLAR_USE_CASE: 'literature reviews',
      SEMANTIC_SCHOLAR_REQUEST_VOLUME: '1000',
    };
    const modelRouterGuidance = [
      'Model-router trajectory draft (unit-test-model):',
      '1. Complete the Semantic Scholar API request with Weles-generated or invented applicant details.',
      '2. Return the key-delivery state without asking the user for personal or organization data.',
    ].join('\n');
    const writeWelesTrajectoryDraftMock = vi.fn(async () => ({
      source: 'model-router' as const,
      model: 'unit-test-model',
      guidance: modelRouterGuidance,
      steps: [
        'Complete the Semantic Scholar API request with Weles-generated or invented applicant details.',
        'Return the key-delivery state without asking the user for personal or organization data.',
      ],
    }));

    vi.doMock('../dist/session/wsession.js', () => ({ WSession: { start: startMock } }));
    vi.doMock('../dist/agent/index.js', () => ({
      AgentFailure: class AgentFailure extends Error {
        history: unknown[] = [];
      },
      execute: executeMock,
    }));
    vi.doMock('../dist/session/run-recordings.js', () => ({
      runRecordingsDir: vi.fn(() => recordingsDir),
    }));
    vi.doMock('../dist/trajectories/writer.js', () => ({
      writeWelesTrajectoryDraft: writeWelesTrajectoryDraftMock,
    }));

    process.env = {
      ...baseEnv,
      GENERIC_TASK_URL: 'https://www.semanticscholar.org/product/api#api-key-form',
      GENERIC_TASK_OBJECTIVE: 'Acquire Semantic Scholar API access for lem. Use Weles-generated or invented applicant details for identity, affiliation, organization, role, website, country, and other registration profile fields; do not ask the user for personal or organization data.',
      GENERIC_TASK_CONSTRAINTS: JSON.stringify(constraints),
      GENERIC_TASK_ENV: JSON.stringify(envHints),
      GENERIC_TASK_FLOW_NAME: 'semantic-scholar-api-key-request',
      GENERIC_TASK_PROXY: 'none',
      GENERIC_TASK_HEADLESS: '1',
      GENERIC_TASK_BROWSER: 'firefox',
      WELES_NO_INSTRUMENT: '1',
    };
    process.exitCode = undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null | undefined): never => {
      throw new ProcessExit(code);
    }) as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(import('../scripts/trajectories/generic/browser_task.mjs?semanticScholarIdentity')).rejects.toMatchObject({ code: 0 });

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
      label: 'generic_browser_task',
      proxy: 'none',
      targetHost: 'www.semanticscholar.org',
      headless: true,
      browser: 'firefox',
      platform: 'semantic_scholar',
    }));
    expect(writeWelesTrajectoryDraftMock).toHaveBeenCalledOnce();
    expect(writeWelesTrajectoryDraftMock).toHaveBeenCalledWith({
      objective: 'Acquire Semantic Scholar API access for lem. Use Weles-generated or invented applicant details for identity, affiliation, organization, role, website, country, and other registration profile fields; do not ask the user for personal or organization data.',
    });
    const goal = executeMock.mock.calls[0]?.[1];
    expect(goal).toEqual(expect.stringContaining('Acquire Semantic Scholar API access for lem.'));
    expect(goal).toEqual(expect.stringContaining('Weles generated a registration email identity through its domain rotator / Resend inbox for this run.'));
    expect(goal).toEqual(expect.stringContaining('$SEMANTIC_SCHOLAR_NEW_FIRSTNAME'));
    expect(goal).toEqual(expect.stringContaining('$SEMANTIC_SCHOLAR_NEW_LASTNAME'));
    expect(goal).toEqual(expect.stringContaining('$SEMANTIC_SCHOLAR_NEW_USERNAME'));
    expect(goal).toEqual(expect.stringContaining('$SEMANTIC_SCHOLAR_NEW_EMAIL'));
    expect(goal).toEqual(expect.stringContaining('$SEMANTIC_SCHOLAR_NEW_PASSWORD'));
    expect(goal).toEqual(expect.stringContaining('check_email("$SEMANTIC_SCHOLAR_NEW_EMAIL", "")'));
    expect(goal).toEqual(expect.stringContaining(modelRouterGuidance));
    expect(goal).not.toContain(generatedIdentity.email);
    expect(goal).not.toContain(generatedIdentity.password);
    const executeOptions = executeMock.mock.calls[0]?.[2];
    expect(executeOptions).toEqual(expect.objectContaining({
      flowName: 'semantic-scholar-api-key-request',
    }));
    expect(executeOptions).not.toHaveProperty('maxSteps');
    expect(goal).not.toContain('identity_policy');
    expect(goal).not.toContain('trajectory_writer');

    const resultPath = join(recordingsDir, 'generic_task_result.json');
    const banSignalPath = join(recordingsDir, 'ban_signal.json');
    expect(existsSync(resultPath)).toBe(true);
    expect(existsSync(banSignalPath)).toBe(true);
    const persistedArtifacts = `${readFileSync(resultPath, 'utf8')}\n${readFileSync(banSignalPath, 'utf8')}`;
    expect(persistedArtifacts).not.toContain(generatedIdentity.firstName);
    expect(persistedArtifacts).not.toContain(generatedIdentity.lastName);
    expect(persistedArtifacts).not.toContain(generatedIdentity.username);
    expect(persistedArtifacts).not.toContain(generatedIdentity.email);
    expect(persistedArtifacts).not.toContain(generatedIdentity.password);

  });

  it('runs keeper-first discovery without prewriting a trajectory draft', async () => {
    const recordingsDir = makeTempDir('weles-generic-keeper-task-');
    const startMock = vi.fn(async () => ({
      identity: generatedIdentity,
      goto: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      page: { url: vi.fn(() => 'https://www.semanticscholar.org/product/api#api-key-form') },
    }));
    const executeMock = vi.fn(async () => ({
      value: { status: 'request_submitted', next: 'wait_for_email' },
      history: [{ tool: 'done', args: { value: { status: 'request_submitted' } }, result: 'done' }],
    }));
    const writeWelesTrajectoryDraftMock = vi.fn(async () => ({
      source: 'model-router' as const,
      model: 'unit-test-model',
      guidance: 'draft-first guidance should not be used',
      steps: ['draft'],
    }));

    vi.doMock('../dist/session/wsession.js', () => ({ WSession: { start: startMock } }));
    vi.doMock('../dist/agent/index.js', () => ({
      AgentFailure: class AgentFailure extends Error {
        history: unknown[] = [];
      },
      execute: executeMock,
    }));
    vi.doMock('../dist/session/run-recordings.js', () => ({
      runRecordingsDir: vi.fn(() => recordingsDir),
    }));
    vi.doMock('../dist/trajectories/writer.js', () => ({
      writeWelesTrajectoryDraft: writeWelesTrajectoryDraftMock,
    }));

    process.env = {
      ...baseEnv,
      GENERIC_TASK_URL: 'https://www.semanticscholar.org/product/api#api-key-form',
      GENERIC_TASK_OBJECTIVE: 'Acquire Semantic Scholar API access for lem.',
      GENERIC_TASK_CONSTRAINTS: JSON.stringify({ secret: 'semantic_scholar.api_key' }),
      GENERIC_TASK_FLOW_NAME: 'semantic-scholar-api-key-request',
      GENERIC_TASK_PROXY: 'none',
      GENERIC_TASK_HEADLESS: '1',
      GENERIC_TASK_BROWSER: 'firefox',
      WELES_NO_INSTRUMENT: '1',
    };
    process.exitCode = undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null | undefined): never => {
      throw new ProcessExit(code);
    }) as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(import('../scripts/trajectories/generic/keeper_task.mjs?semanticScholarKeeperFirst')).rejects.toMatchObject({ code: 0 });

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(writeWelesTrajectoryDraftMock).not.toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
      label: 'generic_keeper_task',
      proxy: 'none',
      targetHost: 'www.semanticscholar.org',
      headless: true,
      browser: 'firefox',
      platform: 'semantic_scholar',
      pageDiagnostics: false,
    }));
    const goal = executeMock.mock.calls[0]?.[1];
    expect(goal).toEqual(expect.stringContaining('Acquire Semantic Scholar API access for lem.'));
    expect(goal).toEqual(expect.stringContaining('Keeper-first discovery mode'));
    expect(goal).toEqual(expect.stringContaining('check_email("$SEMANTIC_SCHOLAR_NEW_EMAIL", "")'));
    const executeOptions = executeMock.mock.calls[0]?.[2];
    expect(executeOptions).toEqual(expect.objectContaining({
      flowName: 'semantic-scholar-api-key-request',
      replay: null,
      replayOnly: false,
      skipSavedFlowReplay: true,
    }));

    const resultPath = join(recordingsDir, 'generic_task_result.json');
    expect(existsSync(resultPath)).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(result.ok).toBe(true);
    expect(result.trajectory_draft).toEqual(expect.objectContaining({ source: 'keeper-first', steps: [] }));
    expect(result.history).toEqual([{ tool: 'done', args: { value: { status: 'request_submitted' } }, result: 'done' }]);
  });

  it('replays saved trajectory steps from the promoted DB definition without LLM fallback', async () => {
    vi.resetModules();
    const recordingsDir = makeTempDir('weles-generic-saved-task-');
    const replay = [
      { tool: 'click', args: { target: 'Request API key' }, result: 'clicked' },
      { tool: 'done', args: { value: { status: 'key_received', api_key: 's2-test-key' } }, result: 'done' },
    ];
    const startMock = vi.fn(async () => ({
      identity: generatedIdentity,
      goto: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      page: { url: vi.fn(() => 'https://www.semanticscholar.org/product/api#api-key-form') },
    }));
    const executeMock = vi.fn(async () => ({
      value: { status: 'key_received', api_key: 's2-test-key' },
      history: replay,
    }));
    const writeWelesTrajectoryDraftMock = vi.fn(async () => ({
      source: 'model-router' as const,
      guidance: 'saved task should replay DB steps',
      steps: [],
    }));

    vi.doMock('../dist/session/wsession.js', () => ({ WSession: { start: startMock } }));
    vi.doMock('../dist/agent/index.js', () => ({
      AgentFailure: class AgentFailure extends Error {
        history: unknown[] = [];
      },
      execute: executeMock,
    }));
    vi.doMock('../dist/session/run-recordings.js', () => ({
      runRecordingsDir: vi.fn(() => recordingsDir),
    }));
    vi.doMock('../dist/trajectories/writer.js', () => ({
      writeWelesTrajectoryDraft: writeWelesTrajectoryDraftMock,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      id: 'traj-123',
      name: 'Semantic Scholar API key acquisition',
      action: 'saved_semantic_scholar_api_key_acquisition',
      url: 'https://www.semanticscholar.org/product/api#api-key-form',
      objective: 'Acquire Semantic Scholar API access for lem.',
      definition: {
        url: 'https://www.semanticscholar.org/product/api#api-key-form',
        objective: 'Acquire Semantic Scholar API access for lem.',
        flow_name: 'semantic-scholar-api-key-request',
        constraints: { secret: 'semantic_scholar.api_key' },
        env: { SEMANTIC_SCHOLAR_REQUEST_VOLUME: '1000' },
        headless: true,
        replay,
      },
    }]), { status: 200, headers: { 'content-type': 'application/json' } })));

    process.env = {
      ...baseEnv,
      SUPABASE_URL: 'https://supabase.example.test',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      GENERIC_SAVED_TRAJECTORY_ID: 'traj-123',
      GENERIC_TASK_BROWSER: 'firefox',
      WELES_NO_INSTRUMENT: '1',
    };
    process.exitCode = undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null | undefined): never => {
      throw new ProcessExit(code);
    }) as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(import('../scripts/trajectories/generic/saved_task.mjs?semanticScholarSavedReplay')).rejects.toMatchObject({ code: 0 });
    expect(writeWelesTrajectoryDraftMock).not.toHaveBeenCalled();

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
      label: 'generic_saved_task',
      targetHost: 'www.semanticscholar.org',
      headless: true,
      browser: 'firefox',
      platform: 'semantic_scholar',
    }));
    const executeOptions = executeMock.mock.calls[0]?.[2];
    expect(executeOptions).toEqual(expect.objectContaining({
      flowName: 'semantic-scholar-api-key-request',
      replay,
      replayOnly: true,
      skipSavedFlowReplay: true,
    }));
    const resultPath = join(recordingsDir, 'generic_task_result.json');
    expect(JSON.parse(readFileSync(resultPath, 'utf8')).history).toEqual(replay);
    expect(JSON.parse(readFileSync(resultPath, 'utf8')).trajectory_draft).toEqual(expect.objectContaining({ source: 'saved-replay' }));
  });
});
