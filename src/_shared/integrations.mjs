// A journey's route to third-party providers: `POST
// /api/integration/<domain>/<action>` on wisent-integrations, which holds the
// provider keys. A journey holds only Weles' integration bearer
// (WELES_STADO_INTEGRATION_TOKEN) and the service origin
// (STADO_INTEGRATION_API_URL). The compiled twin is src/utils/integrations.ts.

export function integrationsConfigured() {
  return Boolean(
    process.env.STADO_INTEGRATION_API_URL?.trim() &&
      process.env.WELES_STADO_INTEGRATION_TOKEN?.trim(),
  );
}

/**
 * One integration action. A refusal names the endpoint, the HTTP status and
 * the boundary's own error body, so a failed provider step says what failed.
 */
export async function integrationAction(domain, action, body) {
  const base = process.env.STADO_INTEGRATION_API_URL?.trim();
  const token = process.env.WELES_STADO_INTEGRATION_TOKEN?.trim();
  if (!base)
    throw new Error(
      `${domain}/${action}: STADO_INTEGRATION_API_URL is not set, so wisent-integrations cannot be reached`,
    );
  if (!token)
    throw new Error(
      `${domain}/${action}: WELES_STADO_INTEGRATION_TOKEN is not set, so wisent-integrations would refuse the call`,
    );
  const endpoint = new URL(
    `api/integration/${domain}/${action}`,
    base.endsWith('/') ? base : `${base}/`,
  );
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error(
      `${endpoint} answered HTTP ${response.status} with a body that is not JSON: ${text.trim() || 'empty'}`,
    );
  }
  if (!response.ok || envelope?.ok !== true || !envelope.result) {
    throw new Error(
      `${endpoint} answered HTTP ${response.status}: ${JSON.stringify(envelope?.error ?? envelope)}`,
    );
  }
  return envelope.result;
}
