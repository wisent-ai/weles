import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../session/run-recordings.js';

// `best` is Brama's subscription route: the agent's HMAC identity selects the
// subscription that pays. Drafting browser trajectories needs a frontier
// instruction-following model, so `best` stays the first choice.
//
// It cannot be the only choice. When both credentials in that subscription pool
// burnt, every browser job died on `429 subscription_unavailable` -- and the
// provider login that would renew the pool is itself a browser job, so nothing
// could recover without an operator. `weles/agent/primary` is the second route
// Brama grants this client; it answers from a deployment Brama holds a direct
// credential for, which is exactly what a burnt subscription needs.
const WELES_AGENT_MODEL = 'best';
const WELES_AGENT_FALLBACK_MODEL = 'weles/agent/primary';
const WELES_AGENT_ID = 'weles';

/// A refusal that another alias could still serve: the pool this alias draws
/// on is empty or throttled, not the request malformed or the client unknown.
function isSubscriptionExhausted(message: string): boolean {
  return message.includes('subscription_unavailable')
    || message.includes('capacity_error')
    || message.includes('model router 429');
}

type ModelRouterConfig = {
  routerUrl: string;
  routerToken: string;
  agentId: string;
  agentAuthSecret: string;
  model: string;
};

export type JedenResult = {
  raw: string;
  model: string;
  routerUrl: string;
};

export type JedenCallOptions = {
  modelOnly?: boolean;
  maxSteps?: number;
  timeoutMs?: number;
};

let modelRouterConfig: ModelRouterConfig | null = null;

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function exactCredential(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === Number('0')) return null;
  if (value.trim() !== value || /\s/.test(value)) {
    throw new Error(`${name} must be one exact non-whitespace credential`);
  }
  return value;
}

function canonicalModel(value: string): string {
  if (value !== WELES_AGENT_MODEL && value !== WELES_AGENT_FALLBACK_MODEL) {
    throw new Error(
      `WELES_AGENT_MODEL must be one of the supported Brama aliases ${WELES_AGENT_MODEL}, ${WELES_AGENT_FALLBACK_MODEL}`,
    );
  }
  return value;
}

function secureRouterOrigin(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('STADO_MODEL_ROUTER_URL must be a valid URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('STADO_MODEL_ROUTER_URL must be an origin without credentials, path, query, or fragment');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('STADO_MODEL_ROUTER_URL must use HTTPS, except for loopback HTTP');
  }
  return parsed.origin;
}



function loadModelRouterConfig(): ModelRouterConfig {
  if (modelRouterConfig) return modelRouterConfig;
  const routerUrl = nonEmpty(process.env.STADO_MODEL_ROUTER_URL);
  const routerToken = exactCredential('WELES_STADO_MODEL_ROUTER_TOKEN');
  const agentId = nonEmpty(process.env.WELES_STADO_MODEL_ROUTER_AGENT_ID);
  const agentAuthSecret = exactCredential('WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET');
  if (!routerUrl) {
    throw new Error('missing required STADO_MODEL_ROUTER_URL');
  }
  if (!routerToken) {
    throw new Error('missing required WELES_STADO_MODEL_ROUTER_TOKEN');
  }
  if (Buffer.byteLength(routerToken) < Number('32')) {
    throw new Error('WELES_STADO_MODEL_ROUTER_TOKEN must contain at least 32 bytes');
  }
  if (agentId !== WELES_AGENT_ID) {
    throw new Error(`WELES_STADO_MODEL_ROUTER_AGENT_ID must be the exact Brama identity ${WELES_AGENT_ID}`);
  }
  if (!agentAuthSecret) {
    throw new Error('missing required WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET');
  }
  if (agentAuthSecret === routerToken) {
    throw new Error('Weles Brama bearer and agent HMAC secret must be distinct');
  }
  const secureRouterUrl = secureRouterOrigin(routerUrl);
  for (const siblingName of ['WELES_STADO_OBJECT_API_TOKEN', 'WELES_STADO_MEDIA_ROUTER_TOKEN', 'WELES_ARTIFACT_DELIVERY_TOKEN', 'WELES_ARTIFACT_SIGNING_SECRET']) {
    const sibling = nonEmpty(process.env[siblingName]);
    if (sibling && (sibling === routerToken || sibling === agentAuthSecret)) {
      throw new Error(`Weles Brama credentials must be distinct from ${siblingName}`);
    }
  }
  modelRouterConfig = {
    routerUrl: secureRouterUrl,
    routerToken,
    agentId,
    agentAuthSecret,
    model: canonicalModel(nonEmpty(process.env.WELES_AGENT_MODEL) ?? WELES_AGENT_MODEL),
  };
  return modelRouterConfig;
}

function runJedenProcess(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  execFile(binary, args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    maxBuffer: Number('10') * Number('1024') * Number('1024'),
    timeout: timeoutMs,
  }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(`Jeden failed: ${String(stderr || error.message).trim().slice(Number('0'), Number('500'))}`));
      return;
    }
    resolve({ stdout, stderr });
  });
  return promise;
}

export async function callJeden(prompt: string, options: JedenCallOptions = {}): Promise<JedenResult> {
  const cfg = loadModelRouterConfig();
  const configuredTimeout = Number.parseInt(process.env.WELES_JEDEN_TIMEOUT_MS ?? '', Number('10'));
  const timeoutMs = options.timeoutMs ?? (
    Number.isFinite(configuredTimeout) && configuredTimeout > Number('0')
      ? configuredTimeout
      : Number('300000')
  );
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= Number('0')) {
    throw new Error('Jeden timeout must be a positive integer number of milliseconds');
  }
  const binary = nonEmpty(process.env.WELES_JEDEN_BIN) ?? 'jeden';
  const sessionRoot = nonEmpty(process.env.WELES_JEDEN_SESSION_ROOT)
    ?? join(runRecordingsDir('jeden'), 'sessions');
  mkdirSync(sessionRoot, { recursive: true });
  const argsFor = (model: string): string[] => {
    const built = [
      'run',
      prompt,
      '--json',
      '--model',
      model,
      '--max-steps',
      String(options.maxSteps ?? 1),
      '--cwd',
      process.cwd(),
    ];
    if (options.modelOnly !== false) built.splice(3, 0, '--model-only');
    return built;
  };
  // Give the child only process mechanics plus the dedicated Brama
  // model-routing capability. Browser-session, provider, and sibling Stado
  // credentials must never become ambient CLI environment.
  const jedenEnv: NodeJS.ProcessEnv = {};
  for (const envName of [
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'PATH',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
    'XDG_CONFIG_HOME',
  ]) {
    const value = process.env[envName];
    if (value) jedenEnv[envName] = value;
  }
  const childEnv = {
    ...jedenEnv,
    STADO_MODEL_ROUTER_URL: cfg.routerUrl,
    STADO_MODEL_ROUTER_TOKEN: cfg.routerToken,
    BRAMA_URL: cfg.routerUrl,
    BRAMA_TOKEN: cfg.routerToken,
    WISENT_APP_AGENT_ID: cfg.agentId,
    WISENT_APP_AGENT_AUTH_SECRET: cfg.agentAuthSecret,
    JEDEN_SESSION_ROOT: sessionRoot,
  };
  // The configured alias first, then the one Brama grants this client as a
  // second route. Only an exhausted-pool refusal moves on: any other failure
  // is reported as itself rather than retried into a different model.
  const attempts = cfg.model === WELES_AGENT_FALLBACK_MODEL
    ? [cfg.model]
    : [cfg.model, WELES_AGENT_FALLBACK_MODEL];
  let lastError: Error | null = null;
  for (const model of attempts) {
    let stdout: string;
    try {
      ({ stdout } = await runJedenProcess(binary, argsFor(model), childEnv, timeoutMs));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      lastError = failure;
      if (model !== attempts[attempts.length - Number('1')] && isSubscriptionExhausted(failure.message)) {
        continue;
      }
      throw failure;
    }
    let envelope: { ok?: boolean; text?: unknown; originalError?: unknown };
    try {
      envelope = JSON.parse(stdout) as typeof envelope;
    } catch {
      throw new Error(`Jeden returned invalid JSON: ${stdout.trim().slice(0, 500)}`);
    }
    const raw = typeof envelope.text === 'string' ? envelope.text.trim() : '';
    if (envelope.ok !== true || !raw) {
      const detail = JSON.stringify(envelope).slice(0, 500);
      const failure = new Error(`Jeden returned no model output: ${detail}`);
      lastError = failure;
      if (model !== attempts[attempts.length - Number('1')] && isSubscriptionExhausted(detail)) {
        continue;
      }
      throw failure;
    }
    return { raw, model, routerUrl: cfg.routerUrl };
  }
  throw lastError ?? new Error('Jeden produced no attempt');
}
