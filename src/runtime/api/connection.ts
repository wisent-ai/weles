export type WelesApiOptions = {
  endpoint?: string;
  bearer?: string;
  organizationId?: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
};

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
  return apiConnection(path, options, 'WELES_WORKER_API_BASE', 'WELES_WORKER_TOKEN');
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
