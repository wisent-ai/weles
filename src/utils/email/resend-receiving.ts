// The Resend receiving inbox for Weles' compiled code, read through
// wisent-integrations (`content/resend.receiving.list`, `.get`) instead of
// api.resend.com. The journeys' JavaScript twin is src/_shared/resend-receiving.mjs;
// both speak the same integrations actions and return Resend's own shapes.
import { integrationAction, integrationsConfigured } from '../integrations.js';

export type ReceivedSummary = {
  id: string;
  from?: string | null;
  to?: Array<string | { email?: string }>;
  subject?: string | null;
  created_at?: string | null;
};

export type ReceivedPage = { data: ReceivedSummary[]; has_more?: boolean };

export const receivingConfigured = integrationsConfigured;

/** One page of received messages: `limit` of them (1-100), after the cursor `after` when given. */
export async function listReceived(limit: number, email?: string, after?: string): Promise<ReceivedPage> {
  const request: Record<string, unknown> = { limit };
  if (email) request.email = email;
  if (after) request.after = after;
  return integrationAction<ReceivedPage>('content', 'resend.receiving.list', request);
}

/** One received message with its subject, text, html and headers. */
export async function getReceived(id: string): Promise<Record<string, unknown>> {
  return integrationAction<Record<string, unknown>>('content', 'resend.receiving.get', { id });
}
