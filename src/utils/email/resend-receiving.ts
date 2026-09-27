// The Resend receiving inbox for Weles' compiled code, read through
// wisent-integrations (`content/resend.receiving.list`, `.get`) instead of
// api.resend.com. The journeys' JavaScript twin is src/_shared/resend-receiving.mjs;
// both speak the same integrations actions and return Resend's own shapes.

export type ReceivedSummary = {
  id: string;
  from?: string | null;
  to?: Array<string | { email?: string }>;
  subject?: string | null;
  created_at?: string | null;
};

export type ReceivedPage = { data: ReceivedSummary[]; has_more?: boolean };

function connection(): { base: string; token: string } {
  const base = process.env.STADO_INTEGRATION_API_URL?.trim();
  const token = process.env.WELES_STADO_INTEGRATION_TOKEN?.trim();
  if (!base) throw new Error('Resend inbox: STADO_INTEGRATION_API_URL is not set, so wisent-integrations cannot be reached');
  if (!token) throw new Error('Resend inbox: WELES_STADO_INTEGRATION_TOKEN is not set, so wisent-integrations would refuse the read');
  return { base, token };
}

async function action<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { base, token } = connection();
  const endpoint = new URL(`api/integration/content/${name}`, base.endsWith('/') ? base : `${base}/`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let envelope: { ok?: unknown; result?: unknown; error?: unknown };
  try { envelope = JSON.parse(text) as typeof envelope; }
  catch { throw new Error(`Resend inbox: ${endpoint} answered HTTP ${response.status} with a body that is not JSON: ${text.trim().slice(0, 300) || 'empty'}`); }
  if (!response.ok || envelope.ok !== true || !envelope.result) {
    throw new Error(`Resend inbox: ${endpoint} answered HTTP ${response.status}: ${JSON.stringify(envelope.error ?? envelope).slice(0, 300)}`);
  }
  return envelope.result as T;
}

export function receivingConfigured(): boolean {
  return Boolean(process.env.STADO_INTEGRATION_API_URL?.trim() && process.env.WELES_STADO_INTEGRATION_TOKEN?.trim());
}

/** One page of received messages: `limit` of them (1-100), after the cursor `after` when given. */
export async function listReceived(limit: number, email?: string, after?: string): Promise<ReceivedPage> {
  const request: Record<string, unknown> = { limit };
  if (email) request.email = email;
  if (after) request.after = after;
  return action<ReceivedPage>('resend.receiving.list', request);
}

/** One received message with its subject, text, html and headers. */
export async function getReceived(id: string): Promise<Record<string, unknown>> {
  return action<Record<string, unknown>>('resend.receiving.get', { id });
}
