import { getReceived, listReceived, receivingConfigured } from '../../../_shared/resend-receiving.mjs';

/** Whether an inbox is configured for the verification mail at all. */
export function inboxConfigured() {
  return receivingConfigured();
}

async function fetchInboxRecent() {
  return (await listReceived(20)).data;
}

async function fetchEmailBody(id) {
  return getReceived(id);
}

function addressedTo(message, email) {
  const to = (Array.isArray(message.to) ? message.to : [])
    .map((t) => (typeof t === 'string' ? t : String(t.email)))
    .join(',')
    .toLowerCase();
  return to.includes(email.toLowerCase());
}

/**
 * The ids of the messages the inbox already holds for `email`, read before
 * signup: the verification mail is the one that is not among them, so no
 * clock tolerance decides which message is new.
 */
export async function inboxIdsFor(email) {
  const inbox = await fetchInboxRecent();
  return new Set(inbox.filter((m) => addressedTo(m, email)).map((m) => m.id));
}

/**
 * One read of the receiving inbox for Pangram's verification mail to `email`
 * that was not there before signup (`seenBefore`). Returns the code and the
 * Pangram link it carries, or null when it has not arrived — the inbox has
 * no push or blocking read, so the caller decides what a missing mail means
 * instead of this waiting.
 */
export async function readPangramMail(email, seenBefore) {
  const inbox = await fetchInboxRecent();
  const hit = inbox.find((m) => {
    const from = String(m.from).toLowerCase();
    const subj = String(m.subject).toLowerCase();
    return addressedTo(m, email) && !seenBefore.has(m.id)
      && (from.includes('pangram') || subj.includes('pangram') || subj.includes('verify'));
  });
  if (!hit) return null;
  const body = await fetchEmailBody(hit.id);
  const text = `${body.subject || ''}\n${body.text || ''}\n${body.html || ''}`;
  const code = text.match(/\b\d{5,6}\b/)?.[0] || null;
  const links = [...text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));
  const pangramLink = links.find((u) => /pangram\.com/i.test(u)) || null;
  return { id: hit.id, subject: body.subject || hit.subject || '', code, pangramLink };
}
