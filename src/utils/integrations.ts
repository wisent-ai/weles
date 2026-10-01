// Weles' route to third-party providers: `POST /api/integration/<domain>/<action>`
// on wisent-integrations, which holds the provider keys. Weles holds only its
// integration bearer (WELES_STADO_INTEGRATION_TOKEN) and the service origin
// (STADO_INTEGRATION_API_URL).

export function integrationsConfigured(): boolean {
  return Boolean(process.env.STADO_INTEGRATION_API_URL?.trim() && process.env.WELES_STADO_INTEGRATION_TOKEN?.trim());
}

/**
 * One integration action. A refusal names the endpoint, the HTTP status and
 * the boundary's own error body, so a failed provider step says what failed.
 */
export async function integrationAction<T>(domain: string, action: string, body: Record<string, unknown>): Promise<T> {
  const base = process.env.STADO_INTEGRATION_API_URL?.trim();
  const token = process.env.WELES_STADO_INTEGRATION_TOKEN?.trim();
  if (!base) throw new Error(`${domain}/${action}: STADO_INTEGRATION_API_URL is not set, so wisent-integrations cannot be reached`);
  if (!token) throw new Error(`${domain}/${action}: WELES_STADO_INTEGRATION_TOKEN is not set, so wisent-integrations would refuse the call`);
  const endpoint = new URL(`api/integration/${domain}/${action}`, base.endsWith('/') ? base : `${base}/`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let envelope: { ok?: unknown; result?: unknown; error?: unknown };
  try { envelope = JSON.parse(text) as typeof envelope; }
  catch { throw new Error(`${endpoint} answered HTTP ${response.status} with a body that is not JSON: ${text.trim() || 'empty'}`); }
  if (!response.ok || envelope.ok !== true || !envelope.result) {
    throw new Error(`${endpoint} answered HTTP ${response.status}: ${JSON.stringify(envelope.error ?? envelope)}`);
  }
  return envelope.result as T;
}
