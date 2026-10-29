// One single-turn chat completion through the configured model route: Brama
// with this workload's bearer and signed identity, or the direct provider.
import { createHash, createHmac } from 'node:crypto';
import { describeError } from '../../_shared/error-chain/index.cjs';
import { modelMessageContent } from './message.js';
import type { ModelRouterConfig } from './router-config.js';

// Brama's agent signature carries whole epoch seconds; the Date API counts
// milliseconds, and the epoch's first second measures how many.
const MILLISECONDS_PER_SECOND = Date.parse('1970-01-01T00:00:01Z');

export type FunctionTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ModelOnlyOptions = {
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

type ToolCall = { function?: { name?: string; arguments?: string } };

type Choice = {
  finish_reason?: string;
  message?: { content?: unknown; tool_calls?: ToolCall[] };
};

type CompletionPayload = { choices?: Choice[]; usage?: unknown };

/** The bearer and, for Brama, the signed agent identity over `body`. */
function routeHeaders(
  cfg: ModelRouterConfig,
  body: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (cfg.routerToken) headers.authorization = `Bearer ${cfg.routerToken}`;
  if (cfg.agentAuthSecret) {
    const timestamp = Math.floor(
      Date.now() / MILLISECONDS_PER_SECOND,
    ).toString();
    const bodyHash = createHash('sha256').update(body).digest('hex');
    headers['x-agent-id'] = cfg.agentId;
    headers['x-agent-timestamp'] = timestamp;
    headers['x-agent-body-sha256'] = bodyHash;
    headers['x-agent-signature'] = createHmac('sha256', cfg.agentAuthSecret)
      .update(`${cfg.agentId}:${timestamp}:${bodyHash}`)
      .digest('hex');
  }
  return headers;
}

/** The function call when the answer holds exactly one, else nothing. */
function soleCall(calls: ToolCall[] | undefined): ToolCall | undefined {
  if (!Array.isArray(calls)) return undefined;
  const [only, ...rest] = calls;
  return rest.length ? undefined : only;
}

/** The answer text: the one declared function's arguments when tools were given, else the message content. */
function answerOf(
  choice: Choice | undefined,
  text: string,
  model: string,
  options: ModelOnlyOptions,
): string {
  const { tools, maxOutputTokens } = options;
  let content = choice?.message?.content;
  if (tools) {
    const returned = soleCall(choice?.message?.tool_calls)?.function;
    if (
      !tools.some((tool) => tool.function.name === returned?.name) ||
      typeof returned?.arguments !== 'string'
    )
      throw new Error(
        `model router did not return one declared function for ${model}: ${text}`,
      );
    content = returned.arguments;
  }
  const answer = typeof content === 'string' ? content.trim() : '';
  if (!answer) {
    const bound =
      maxOutputTokens === undefined
        ? 'no max_tokens was sent'
        : `max_tokens=${maxOutputTokens}`;
    throw new Error(
      `model router returned no content for ${model} (${bound}): ${text}`,
    );
  }
  return answer;
}

/**
 * The model route did not answer at all: the connection failed or broke
 * before an answer was read. Distinct from a refusal the route answered, so
 * a caller asks the alternative Stado resolves only for this.
 */
export class RouteUnreachable extends Error {}

/** Single-turn inference uses the caller's Brama identity; native tools require modelOnly: false. */
export async function completeThroughRouter(
  cfg: ModelRouterConfig,
  prompt: string,
  options: ModelOnlyOptions,
): Promise<JedenResult> {
  const { images, tools, maxOutputTokens } = options;
  const model = images?.length ? cfg.imageModel : cfg.model;
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'user', content: await modelMessageContent(prompt, images) },
    ],
    ...(tools ? { tools, tool_choice: 'required' } : {}),
    ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
  });
  const address = `${cfg.routerUrl}/v1/chat/completions`;
  const response = await fetch(address, {
    method: 'POST',
    headers: routeHeaders(cfg, body),
    body,
  }).catch((error: unknown) => {
    throw new RouteUnreachable(
      `${cfg.direct ? 'WELES_MODEL_ENDPOINT' : 'Brama'} POST ${address} for ${model} failed: ${describeError(error)}`,
      { cause: error },
    );
  });
  // A connection lost while the answer's body is read is the same transport
  // failure, now with the status the answer had already given.
  const text = await response.text().catch((error: unknown) => {
    throw new RouteUnreachable(
      `${cfg.direct ? 'WELES_MODEL_ENDPOINT' : 'Brama'} POST ${address} for ${model} answered HTTP ${response.status}, and its body could not be read: ${describeError(error)}`,
      { cause: error },
    );
  });
  if (!response.ok)
    throw new Error(`model router ${response.status} for ${model}: ${text}`);
  let payload: CompletionPayload;
  try {
    payload = JSON.parse(text) as CompletionPayload;
  } catch (error) {
    throw new Error(`model router returned invalid JSON: ${text}`, {
      cause: error,
    });
  }
  const [choice] = Array.isArray(payload.choices) ? payload.choices : [];
  return {
    raw: answerOf(choice, text, model, options),
    model,
    routerUrl: cfg.routerUrl,
    finishReason: choice?.finish_reason,
    usage: payload.usage,
    functionName: tools
      ? soleCall(choice?.message?.tool_calls)?.function?.name
      : undefined,
  };
}
