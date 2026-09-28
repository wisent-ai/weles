// The Resend receiving inbox, read through wisent-integrations
// (`content/resend.receiving.list`, `content/resend.receiving.get`). The
// Resend key stays in the integrations service; a journey holds only Weles'
// integration bearer.
//
// The answers keep Resend's own shapes — `{ data: [{ id, from, to, subject,
// created_at }] }` for a list and `{ id, from, to, subject, text, html,
// created_at, headers }` for one message — so a journey that read Resend
// directly reads these unchanged.

import { integrationAction, integrationsConfigured } from './integrations.mjs';

function action(name, body) {
  return integrationAction('content', name, body);
}

/** Whether a journey can read the inbox at all. */
export const receivingConfigured = integrationsConfigured;

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
