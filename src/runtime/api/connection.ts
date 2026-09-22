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

export function welesApiConnection(path: string, options: WelesApiOptions = {}) {
  const environment = options.environment ?? process.env;
  const raw = required(options.endpoint ?? environment.WELES_API_BASE, 'WELES_API_BASE');
  let base: URL;
  try { base = new URL(raw); }
  catch { throw new Error('WELES_API_BASE must be a URL'); }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error('WELES_API_BASE must not contain credentials, query parameters, or a fragment');
  }
  const loopback = base.hostname === 'localhost' || base.hostname === '127.0.0.1' || base.hostname === '[::1]';
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new Error('WELES_API_BASE must use HTTPS unless it names a loopback host');
  }
  const bearer = required(options.bearer ?? environment.WELES_TOKEN, 'WELES_TOKEN');
  const organizationId = required(options.organizationId ?? environment.WISENT_ORGANIZATION_ID, 'WISENT_ORGANIZATION_ID').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error('WISENT_ORGANIZATION_ID must be a UUID');
  }
  return {
    endpoint: new URL(path, base), organizationId, fetch: options.fetch ?? fetch,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'X-Wisent-Organization-ID': organizationId,
    },
  };
}
