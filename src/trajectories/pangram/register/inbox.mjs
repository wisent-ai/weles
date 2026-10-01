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

/**
 * One read of the receiving inbox for Pangram's verification mail to `email`
 * sent after `sinceMs`. Returns the code and the Pangram link it carries, or
 * null when it has not arrived — the inbox has no push or blocking read, so
 * the caller decides what a missing mail means instead of this waiting.
 */
export async function readPangramMail(email, sinceMs) {
  const inbox = await fetchInboxRecent();
  const hit = inbox.find((m) => {
    const to = (Array.isArray(m.to) ? m.to : []).map((t) => typeof t === 'string' ? t : t.email || '').join(',').toLowerCase();
    const from = String(m.from || '').toLowerCase();
    const subj = String(m.subject || '').toLowerCase();
    const created = m.created_at ? Date.parse(m.created_at) : 0;
    return to.includes(email.toLowerCase()) && created >= sinceMs - 60_000 && (from.includes('pangram') || subj.includes('pangram') || subj.includes('verify'));
  });
  if (!hit) return null;
  const body = await fetchEmailBody(hit.id);
  const text = `${body.subject || ''}\n${body.text || ''}\n${body.html || ''}`;
  const code = text.match(/\b\d{5,6}\b/)?.[0] || null;
  const links = [...text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));
  const pangramLink = links.find((u) => /pangram\.com/i.test(u)) || null;
  return { id: hit.id, subject: body.subject || hit.subject || '', code, pangramLink };
}
