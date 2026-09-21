import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../session/run-recordings.js';
import { modelMessageContent } from './model/message.js';

// Text decisions use this workload's Brama alias. Image questions use `best`,
// which selects an image-capable model from the same caller's authorized pool.
// Brama owns provider choice and permissions; Weles never substitutes a vendor.
export const WELES_AGENT_MODEL = 'weles';
const WELES_AGENT_ID = 'weles';

type ModelRouterConfig = {
  routerUrl: string;
  routerToken: string;
  agentId: string;
  agentAuthSecret: string;
  model: string;
};

export type FunctionTool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
type ModelOnlyOptions = {
  modelOnly?: true;
  images?: readonly Buffer[];
  tools?: readonly FunctionTool[];
  maxOutputTokens?: number;
};

export type JedenResult = {
  raw: string;
  model: string;
  routerUrl: string;
  finishReason?: string;
  usage?: unknown;
  functionName?: string;
};

export type JedenCallOptions = {
  maxSteps?: number;
} & (ModelOnlyOptions | { modelOnly: false; cwd: string });

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
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  execFile(binary, args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    maxBuffer: Number('10') * Number('1024') * Number('1024'),
  }, (error, stdout, stderr) => {
    if (error) {
      const detail = String(stderr || stdout).trim();
      reject(new Error(`Jeden ${binary} failed: code=${error.code ?? 'none'} signal=${error.signal ?? 'none'} killed=${error.killed ?? false}${detail ? `; ${detail.slice(Number('0'), Number('500'))}` : ''}`, { cause: error }));
      return;
    }
    resolve({ stdout, stderr });
  });
  return promise;
}

/** Single-turn inference uses the caller's Brama identity; native tools require modelOnly: false. */
async function completeThroughRouter(
  cfg: ModelRouterConfig,
  prompt: string,
  options: ModelOnlyOptions,
): Promise<JedenResult> {
  const { images, tools, maxOutputTokens } = options;
  const model = images?.length ? 'best' : cfg.model;
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: await modelMessageContent(prompt, images) }],
    ...(tools ? { tools, tool_choice: 'required' } : {}),
    ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
  });
  const timestamp = Math.floor(Date.now() / Number('1000')).toString();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', cfg.agentAuthSecret)
    .update(`${cfg.agentId}:${timestamp}:${bodyHash}`)
    .digest('hex');
  const response = await fetch(`${cfg.routerUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.routerToken}`,
      'content-type': 'application/json',
      'x-agent-id': cfg.agentId,
      'x-agent-timestamp': timestamp,
      'x-agent-body-sha256': bodyHash,
      'x-agent-signature': signature,
    },
    body,
  }).catch(error => {
    const cause = error instanceof Error ? error.cause : undefined;
    throw new Error(`Brama POST ${cfg.routerUrl.replace(/\/+$/, '')}/v1/chat/completions for ${model} failed: ${String(error)}${cause ? `; cause: ${String(cause)}` : ''}`, { cause: error });
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`model router ${response.status} for ${model}: ${text.slice(0, 500)}`);
  }
  let payload: {
    choices?: Array<{ finish_reason?: string; message?: { content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    usage?: unknown;
  };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new Error(`model router returned invalid JSON: ${text.slice(0, 500)}`);
  }
  const choice = payload.choices?.[0];
  let content = choice?.message?.content;
  if (tools) {
    const calls = choice?.message?.tool_calls;
    const returned = calls?.[0]?.function;
    if (!Array.isArray(calls) || calls.length !== 1 || !tools.some(tool => tool.function.name === returned?.name) || typeof returned?.arguments !== 'string')
      throw new Error(`model router did not return one declared function for ${model}: ${text.slice(0, 500)}`);
    content = returned.arguments;
  }
  const answer = typeof content === 'string' ? content.trim() : '';
  if (!answer) {
    throw new Error(`model router returned no content for ${model} (max_tokens=${maxOutputTokens ?? 'gateway default'}): ${text.slice(0, 500)}`);
  }
  return { raw: answer, model, routerUrl: cfg.routerUrl, finishReason: choice?.finish_reason, usage: payload.usage, functionName: tools ? choice?.message?.tool_calls?.[0]?.function?.name : undefined };
}

export async function callJeden(prompt: string, options: JedenCallOptions = {}): Promise<JedenResult> {
  const cfg = loadModelRouterConfig();
  // A turn ends when the gateway answers or the process exits. The browser
  // loop's decision call takes as long as the model takes to think, and a
  // reasoning route that needed six minutes was reported here as a failure of
  // ours.
  //
  // Only a caller that explicitly wants the agent runtime's tools
  // (`modelOnly: false`) spawns the binary.
  if (options.modelOnly !== false) {
    return completeThroughRouter(cfg, prompt, options);
  }
  const binary = nonEmpty(process.env.WELES_JEDEN_BIN)
    ?? join(__dirname, '..', '..', 'native', 'jeden', 'bin', 'jeden');
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
    options.cwd,
  ];
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
    BRAMA_URL: cfg.routerUrl,
    BRAMA_TOKEN: cfg.routerToken,
    WISENT_APP_AGENT_ID: cfg.agentId,
    WISENT_APP_AGENT_AUTH_SECRET: cfg.agentAuthSecret,
    JEDEN_SESSION_ROOT: sessionRoot,
  });
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
