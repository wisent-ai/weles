import { execFileSync } from 'node:child_process';

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

function runStado(args: string[]): string {
  try {
    return execFileSync('stado', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : String(error);
    throw new Error(`stado ${args.join(' ')} failed: ${detail || 'no diagnostic'}`);
  }
}

/**
 * The executor's base URL and bearer when the shell names neither: the route
 * `stado service directory connect` works out from where the executor is
 * placed, and the token Skarbiec holds at the `<item>#<field>` that
 * WELES_WORKER_TOKEN_ITEM names. No item is built in. An explicit
 * WELES_WORKER_API_BASE and WELES_WORKER_TOKEN still win.
 */
function executorFromStado(options: WelesApiOptions): { endpoint: string; bearer: string } {
  const environment = options.environment ?? process.env;
  const coordinate = environment.WELES_WORKER_TOKEN_ITEM?.trim() ?? '';
  const separator = coordinate.indexOf('#');
  if (separator <= 0 || separator === coordinate.length - 1) {
    throw new Error(
      'the executor bearer is not named: set WELES_WORKER_TOKEN_ITEM to the Skarbiec <item>#<field> '
      + 'holding it, or set WELES_WORKER_API_BASE and WELES_WORKER_TOKEN',
    );
  }
  const stado = options.stado ?? runStado;
  const route = JSON.parse(stado([
    'service', 'directory', 'connect', EXECUTOR_SERVICE,
    '--consumer', EXECUTOR_CONSUMER, '--no-verify', '--json',
  ])) as { url?: unknown };
  if (typeof route.url !== 'string' || !route.url) {
    throw new Error(`stado service directory connect ${EXECUTOR_SERVICE} answered no url`);
  }
  const item = coordinate.slice(0, separator);
  const field = coordinate.slice(separator + 1);
  const bearer = stado(['credentials', 'get', item, '--field', field]).trim();
  return { endpoint: route.url, bearer };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (value !== normalized || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} contains invalid whitespace or control characters`);
  }
  return normalized;
}

function apiConnection(path: string, options: WelesApiOptions, endpointName: string, bearerName: string) {
  const environment = options.environment ?? process.env;
  const raw = required(options.endpoint ?? environment[endpointName], endpointName);
  let base: URL;
  try { base = new URL(raw); }
  catch { throw new Error(`${endpointName} must be a URL`); }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error(`${endpointName} must not contain credentials, query parameters, or a fragment`);
  }
  const loopback = base.hostname === 'localhost' || base.hostname === '127.0.0.1' || base.hostname === '[::1]';
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new Error(`${endpointName} must use HTTPS unless it names a loopback host`);
  }
  const bearer = required(options.bearer ?? environment[bearerName], bearerName);
  return {
    endpoint: new URL(path, base), fetch: options.fetch ?? fetch,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
  };
}

export function welesOperatorConnection(path: string, options: WelesApiOptions = {}) {
  const environment = options.environment ?? process.env;
  const named = options.endpoint ?? environment.WELES_WORKER_API_BASE;
  const resolved = named ? options : { ...options, ...executorFromStado(options) };
  return apiConnection(path, resolved, 'WELES_WORKER_API_BASE', 'WELES_WORKER_TOKEN');
}

/**
 * The executor's JSON answer. Whatever stands between the operator and the
 * executor (the Stado forward, a proxy) answers in plain text when it cannot
 * reach it, so a body that is not JSON is reported as the status and text it
 * was, not as a parse error.
 */
export async function operatorJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); }
  catch {
    throw new Error(`HTTP ${response.status} ${response.headers.get('content-type') ?? 'without a content type'} is not the executor's JSON: ${text.trim() || 'empty body'}`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`HTTP ${response.status}: the executor answered JSON that is not an object`);
  }
  return body as Record<string, unknown>;
}

export function welesApiConnection(path: string, options: WelesApiOptions = {}) {
  const connection = apiConnection(path, options, 'WELES_API_BASE', 'WELES_TOKEN');
  const environment = options.environment ?? process.env;
  const organizationId = required(options.organizationId ?? environment.WISENT_ORGANIZATION_ID, 'WISENT_ORGANIZATION_ID').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error('WISENT_ORGANIZATION_ID must be a UUID');
  }
  return {
    ...connection, organizationId,
    headers: {
      ...connection.headers,
      'X-Wisent-Organization-ID': organizationId,
    },
  };
}
