// Where Weles asks a model and as whom: Brama, through the Stado model
// router with this workload's bearer and signed identity; for a user without
// Brama, the OpenAI-compatible provider WELES_MODEL_ENDPOINT names; and with
// neither named, Stado's inference alternatives, each request handed to
// `stado capabilities call inference --consumer weles`.
import { serviceOrigin } from '../../utils/runtime/service-origin.js';

const WELES_AGENT_ID = 'weles';

/** Brama's alias for image questions: an image-capable model from the caller's pool. */
const BRAMA_IMAGE_ALIAS = 'best';

/** The other bearers this process holds, which Brama's credentials must not repeat. */
const SIBLING_SECRETS: Readonly<Record<string, true>> = Object.freeze({
  WELES_STADO_OBJECT_API_TOKEN: true,
  WELES_ARTIFACT_DELIVERY_TOKEN: true,
  WELES_ARTIFACT_SIGNING_SECRET: true,
});

export type ModelRouterConfig = {
  /** The address requests are posted to; empty through Stado. */
  routerUrl: string;
  /** The bearer; a direct provider that takes none has none. */
  routerToken?: string;
  agentId: string;
  /** Brama's HMAC secret; a direct provider is not signed for. */
  agentAuthSecret?: string;
  model: string;
  imageModel: string;
  /** True when WELES_MODEL_ENDPOINT names a provider called without Brama. */
  direct: boolean;
  /** True when no route is named and requests go to Stado's alternatives. */
  viaStado: boolean;
};

let modelRouterConfig: ModelRouterConfig | undefined;

/** The setting's text, trimmed; absent when unset or blank. */
function setting(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** A credential given exactly: absent when unset, refused when it carries whitespace. */
function exactCredential(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  if (/\s/.test(value))
    throw new Error(`${name} must be one exact non-whitespace credential`);
  return value;
}

/** A required credential, refused by name when missing. */
function requiredCredential(name: string): string {
  const value = exactCredential(name);
  if (value === undefined) throw new Error(`missing required ${name}`);
  return value;
}

function directProvider(endpoint: string): ModelRouterConfig {
  const model = setting('WELES_MODEL');
  if (!model)
    throw new Error(
      'WELES_MODEL_ENDPOINT is set but WELES_MODEL is not; name the provider model Weles asks',
    );
  const token = exactCredential('WELES_MODEL_KEY');
  return {
    routerUrl: serviceOrigin('WELES_MODEL_ENDPOINT', endpoint),
    ...(token ? { routerToken: token } : {}),
    agentId: WELES_AGENT_ID,
    model,
    imageModel: model,
    direct: true,
    viaStado: false,
  };
}

function bramaRoute(alias: string): ModelRouterConfig {
  if (!setting('STADO_MODEL_ROUTER_URL'))
    throw new Error(
      'missing required STADO_MODEL_ROUTER_URL; without Brama set WELES_MODEL_ENDPOINT and WELES_MODEL to an OpenAI-compatible provider',
    );
  const routerUrl = serviceOrigin(
    'STADO_MODEL_ROUTER_URL',
    process.env.STADO_MODEL_ROUTER_URL,
  );
  const routerToken = requiredCredential('WELES_STADO_MODEL_ROUTER_TOKEN');
  const agentAuthSecret = requiredCredential(
    'WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET',
  );
  const agentId = setting('WELES_STADO_MODEL_ROUTER_AGENT_ID');
  if (agentId !== WELES_AGENT_ID)
    throw new Error(
      `WELES_STADO_MODEL_ROUTER_AGENT_ID must be the exact Brama identity ${WELES_AGENT_ID}`,
    );
  if (agentAuthSecret === routerToken)
    throw new Error(
      'Weles Brama bearer and agent HMAC secret must be distinct',
    );
  const repeated = Object.keys(SIBLING_SECRETS).find((name) => {
    const sibling = setting(name);
    return sibling === routerToken || sibling === agentAuthSecret;
  });
  if (repeated !== undefined)
    throw new Error(
      `Weles Brama credentials must be distinct from ${repeated}`,
    );
  const stated = setting('WELES_AGENT_MODEL');
  if (stated !== undefined && stated !== alias)
    throw new Error(
      `WELES_AGENT_MODEL must be the exact supported Brama alias ${alias}`,
    );
  return {
    routerUrl,
    routerToken,
    agentId,
    agentAuthSecret,
    model: alias,
    imageModel: BRAMA_IMAGE_ALIAS,
    direct: false,
    viaStado: false,
  };
}

/**
 * Neither WELES_MODEL_ENDPOINT nor STADO_MODEL_ROUTER_URL is named: every
 * request goes to Stado's inference alternatives under Weles's own aliases,
 * and no Brama credential is read.
 */
function stadoAlternatives(alias: string): ModelRouterConfig {
  return {
    routerUrl: '',
    agentId: WELES_AGENT_ID,
    model: alias,
    imageModel: BRAMA_IMAGE_ALIAS,
    direct: false,
    viaStado: true,
  };
}

/**
 * The model route this process asks, read once: the provider
 * WELES_MODEL_ENDPOINT names, else Brama at STADO_MODEL_ROUTER_URL under
 * `alias`, else Stado's inference alternatives.
 */
export function loadModelRouterConfig(alias: string): ModelRouterConfig {
  if (modelRouterConfig) return modelRouterConfig;
  const endpoint = setting('WELES_MODEL_ENDPOINT');
  modelRouterConfig = endpoint
    ? directProvider(endpoint)
    : setting('STADO_MODEL_ROUTER_URL')
      ? bramaRoute(alias)
      : stadoAlternatives(alias);
  return modelRouterConfig;
}
