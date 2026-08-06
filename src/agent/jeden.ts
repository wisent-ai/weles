import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../session/run-recordings.js';

const WELES_AGENT_MODEL = 'weles/agent/primary';
const WELES_AGENT_ID = 'weles';

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
  if (value !== WELES_AGENT_MODEL) {
    throw new Error(`WELES_AGENT_MODEL must be the exact supported Brama alias ${WELES_AGENT_MODEL}`);
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
  const args = [
    'run',
    prompt,
    '--json',
    '--model',
    cfg.model,
    '--max-steps',
    String(options.maxSteps ?? 1),
    '--cwd',
    process.cwd(),
  ];
  if (options.modelOnly !== false) args.splice(3, 0, '--model-only');
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
  const { stdout } = await runJedenProcess(binary, args, {
    ...jedenEnv,
    STADO_MODEL_ROUTER_URL: cfg.routerUrl,
    STADO_MODEL_ROUTER_TOKEN: cfg.routerToken,
    WISENT_APP_AGENT_ID: cfg.agentId,
    WISENT_APP_AGENT_AUTH_SECRET: cfg.agentAuthSecret,
    JEDEN_SESSION_ROOT: sessionRoot,
  }, timeoutMs);
  let envelope: { ok?: boolean; text?: unknown; originalError?: unknown };
  try {
    envelope = JSON.parse(stdout) as typeof envelope;
  } catch {
    throw new Error(`Jeden returned invalid JSON: ${stdout.trim().slice(0, 500)}`);
  }
  const raw = typeof envelope.text === 'string' ? envelope.text.trim() : '';
  if (envelope.ok !== true || !raw) {
    throw new Error(`Jeden returned no model output: ${JSON.stringify(envelope).slice(0, 500)}`);
  }
  return { raw, model: cfg.model, routerUrl: cfg.routerUrl };
}
