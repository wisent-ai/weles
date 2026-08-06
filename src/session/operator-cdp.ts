export interface OperatorCdpConfig {
  endpoint: string;
  token: string;
}

const TOKEN_SIBLINGS = [
  'WELES_STADO_OBJECT_API_TOKEN',
  'WELES_STADO_MODEL_ROUTER_TOKEN',
  'WELES_STADO_MEDIA_ROUTER_TOKEN',
  'WELES_ARTIFACT_DELIVERY_TOKEN',
  'WELES_DATABASE_TOKEN',
  'CONTENT_DIAGNOSTICS_API_TOKEN',
  'TRADING_TOOLS_INGEST_TOKEN',
] as const;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
    || hostname === '::1' || hostname === '[::1]';
}

export function loadOperatorCdpConfig(env: NodeJS.ProcessEnv = process.env): OperatorCdpConfig {
  const rawEndpoint = String(env.WELES_OPERATOR_CDP_URL ?? '').trim();
  const token = String(env.WELES_OPERATOR_CDP_TOKEN ?? '').trim();
  if (!rawEndpoint) throw new Error('operator CDP mode requires WELES_OPERATOR_CDP_URL');
  if (Buffer.byteLength(token) < Number('32')) {
    throw new Error('operator CDP mode requires WELES_OPERATOR_CDP_TOKEN with at least 32 bytes');
  }
  for (const siblingName of TOKEN_SIBLINGS) {
    const sibling = String(env[siblingName] ?? '').trim();
    if (sibling && sibling === token) {
      throw new Error(`WELES_OPERATOR_CDP_TOKEN must be distinct from ${siblingName}`);
    }
  }

  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error('WELES_OPERATOR_CDP_URL must be a valid URL');
  }
  const tls = endpoint.protocol === 'https:' || endpoint.protocol === 'wss:';
  const authenticatedLoopback = isLoopback(endpoint.hostname)
    && (endpoint.protocol === 'http:' || endpoint.protocol === 'ws:');
  if (!tls && !authenticatedLoopback) {
    throw new Error('WELES_OPERATOR_CDP_URL must use TLS, except for authenticated loopback');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('WELES_OPERATOR_CDP_URL must not contain credentials, query, or fragment');
  }
  return { endpoint: endpoint.toString(), token };
}
