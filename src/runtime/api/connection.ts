import { execFileSync } from 'node:child_process';
import { loopbackHost } from '../../utils/runtime/service-origin.js';

export type WelesApiOptions = {
  endpoint?: string;
  bearer?: string;
  organizationId?: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Runs one `stado` command and returns its standard output. */
  stado?: (args: string[]) => string;
};

/** The executor's route as the service directory places it, for an operator shell. */
const EXECUTOR_SERVICE = 'weles-admission';
const EXECUTOR_CONSUMER = 'operator';
/** The role whose `token` the worker accepts on its general API: the one the
 * launcher reads into WELES_API_TOKEN (weles-api-launcher/configuration.mjs,
 * STARTUP_FIELDS). A role, never an item: whichever item plays it is read. */
const EXECUTOR_BEARER_ROLE = 'echo-weles-api';
const EXECUTOR_BEARER_FIELD = 'token';

/** A UUID in its text form, 8-4-4-4-12 hex digits (RFC 9562, section 4): https://www.rfc-editor.org/rfc/rfc9562#section-4 */
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function runStado(args: string[]): string {
  try {
    return execFileSync('stado', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String(error.stderr).trim()
        : '';
    throw new Error(
      `stado ${args.join(' ')} failed: ${stderr ? stderr : messageOf(error)}`,
    );
  }
}

/**
 * The executor's base URL and bearer when the shell names neither: the route
 * `stado service directory connect` works out from where the executor is
 * placed, and the token of the item playing the worker's API role, read
 * through `stado credentials get --role`. An explicit WELES_WORKER_API_BASE
 * and WELES_WORKER_TOKEN still win.
 */
function executorFromStado(options: WelesApiOptions): {
  endpoint: string;
  bearer: string;
} {
  const stado = options.stado ?? runStado;
  const route = JSON.parse(
    stado([
      'service',
      'directory',
      'connect',
      EXECUTOR_SERVICE,
      '--consumer',
      EXECUTOR_CONSUMER,
      '--no-verify',
      '--json',
    ]),
  ) as { url?: unknown };
  if (typeof route.url !== 'string' || !route.url) {
    throw new Error(
      `stado service directory connect ${EXECUTOR_SERVICE} answered no url`,
    );
  }
  const bearer = stado([
    'credentials',
    'get',
    '--role',
    EXECUTOR_BEARER_ROLE,
    '--field',
    EXECUTOR_BEARER_FIELD,
  ]).trim();
  return { endpoint: route.url, bearer };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (value !== normalized || /\p{Cc}/u.test(value)) {
    throw new Error(
      `${name} contains invalid whitespace or control characters`,
    );
  }
  return normalized;
}

function apiConnection(
  path: string,
  options: WelesApiOptions,
  endpointName: string,
  bearerName: string,
) {
  const environment = options.environment ?? process.env;
  const raw = required(
    options.endpoint ?? environment[endpointName],
    endpointName,
  );
  let base: URL;
  try {
    base = new URL(raw);
  } catch (error) {
    throw new Error(`${endpointName} must be a URL: ${messageOf(error)}`);
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error(
      `${endpointName} must not contain credentials, query parameters, or a fragment`,
    );
  }
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && loopbackHost(base.hostname))
  ) {
    throw new Error(
      `${endpointName} must use HTTPS unless it names a loopback host`,
    );
  }
  const bearer = required(
    options.bearer ?? environment[bearerName],
    bearerName,
  );
  return {
    endpoint: new URL(path, base),
    fetch: options.fetch ?? fetch,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
  };
}

export function welesOperatorConnection(
  path: string,
  options: WelesApiOptions = {},
) {
  const environment = options.environment ?? process.env;
  const named = options.endpoint ?? environment.WELES_WORKER_API_BASE;
  const resolved = named
    ? options
    : { ...options, ...executorFromStado(options) };
  return apiConnection(
    path,
    resolved,
    'WELES_WORKER_API_BASE',
    'WELES_WORKER_TOKEN',
  );
}

/** How an answer that is not JSON is named: its status, its content type, and its body or that it had none. */
function unparsedAnswer(response: Response, text: string): string {
  const type = response.headers.get('content-type');
  const typed = type ? type : 'without a content type';
  const body = text.trim();
  if (!body) return `HTTP ${response.status} ${typed} with an empty body`;
  return `HTTP ${response.status} ${typed}: ${body}`;
}

/**
 * The executor's JSON answer. Whatever stands between the operator and the
 * executor (the Stado forward, a proxy) answers in plain text when it cannot
 * reach it, so a body that is not JSON is reported as the status and text it
 * was, with the parser's reason.
 */
export async function operatorJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${unparsedAnswer(response, text)} is not the executor's JSON (${messageOf(error)})`,
    );
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(
      `HTTP ${response.status}: the executor answered JSON that is not an object`,
    );
  }
  return body as Record<string, unknown>;
}

export function welesApiConnection(
  path: string,
  options: WelesApiOptions = {},
) {
  const connection = apiConnection(
    path,
    options,
    'WELES_API_BASE',
    'WELES_TOKEN',
  );
  const environment = options.environment ?? process.env;
  const organizationId = required(
    options.organizationId ?? environment.WISENT_ORGANIZATION_ID,
    'WISENT_ORGANIZATION_ID',
  ).toLowerCase();
  if (!UUID_TEXT.test(organizationId)) {
    throw new Error('WISENT_ORGANIZATION_ID must be a UUID');
  }
  return {
    ...connection,
    organizationId,
    headers: {
      ...connection.headers,
      'X-Wisent-Organization-ID': organizationId,
    },
  };
}
