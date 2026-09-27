// The Resend receiving inbox, read through wisent-integrations
// (`content/resend.receiving.list`, `content/resend.receiving.get`) instead of
// api.resend.com with a key in the journey's environment. The Resend key stays
// in the integrations service; a journey holds only Weles' integration bearer.
//
// The answers keep Resend's own shapes — `{ data: [{ id, from, to, subject,
// created_at }] }` for a list and `{ id, from, to, subject, text, html,
// created_at, headers }` for one message — so a journey that read Resend
// directly reads these unchanged.

function connection() {
  const base = process.env.STADO_INTEGRATION_API_URL?.trim();
  const token = process.env.WELES_STADO_INTEGRATION_TOKEN?.trim();
  if (!base) throw new Error('Resend inbox: STADO_INTEGRATION_API_URL is not set, so wisent-integrations cannot be reached');
  if (!token) throw new Error('Resend inbox: WELES_STADO_INTEGRATION_TOKEN is not set, so wisent-integrations would refuse the read');
  return { base, token };
}

async function action(name, body) {
  const { base, token } = connection();
  const endpoint = new URL(`api/integration/content/${name}`, base.endsWith('/') ? base : `${base}/`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let envelope;
  try { envelope = JSON.parse(text); }
  catch { throw new Error(`Resend inbox: ${endpoint} answered HTTP ${response.status} with a body that is not JSON: ${text.trim().slice(0, 300) || 'empty'}`); }
  if (!response.ok || envelope?.ok !== true || !envelope.result) {
    throw new Error(`Resend inbox: ${endpoint} answered HTTP ${response.status}: ${JSON.stringify(envelope?.error ?? envelope).slice(0, 300)}`);
  }
  return envelope.result;
}

/** Whether a journey can read the inbox at all. */
export function receivingConfigured() {
  return Boolean(process.env.STADO_INTEGRATION_API_URL?.trim() && process.env.WELES_STADO_INTEGRATION_TOKEN?.trim());
}

/**
 * The newest `limit` received messages (the caller's own page size, 1-100),
 * optionally only those addressed to `email`.
 */
export async function listReceived(limit, email) {
  const request = { limit };
  if (email) request.email = email;
  return action('resend.receiving.list', request);
}

/** One received message with its text, html and headers. */
export async function getReceived(id) {
  return action('resend.receiving.get', { id });
}
