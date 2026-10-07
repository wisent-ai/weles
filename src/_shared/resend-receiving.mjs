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

/**
 * The domain of a message's sender, from its `from` address (`Name <a@b.c>`
 * or `a@b.c`), lower-cased; '' when there is none.
 */
export function senderDomain(message) {
  const from =
    typeof message?.from === 'string'
      ? message.from
      : (message?.from?.email ?? '');
  return (from.match(/@([^>\s]+)/)?.[1] ?? '').toLowerCase();
}

/** Whether the message was sent from `domain` or a subdomain of it. */
export function sentFrom(message, domain) {
  const sender = senderDomain(message);
  return sender === domain || sender.endsWith(`.${domain}`);
}

/** The newest received messages addressed to `email` and sent from `domain`, newest first. */
export async function listReceivedFrom(limit, email, domain) {
  const list = await listReceived(limit, email);
  return (list.data ?? [])
    .filter(
      (m) =>
        (m.to ?? [])
          .map((t) => (typeof t === 'string' ? t : t.email))
          .includes(email) && sentFrom(m, domain),
    )
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
}
