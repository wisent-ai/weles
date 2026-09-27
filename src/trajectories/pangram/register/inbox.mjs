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
 * Poll the receiving inbox for Pangram's verification mail to `email` sent
 * after `sinceMs`, for about two minutes. Returns the code and the Pangram
 * link it carries, or null when none arrived.
 */
export async function waitForPangramMail(email, sinceMs) {
  for (let i = 0; i < 24; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000)); // allow-raw-playwright: bounded Resend polling
    let inbox;
    try {
      inbox = await fetchInboxRecent();
    } catch (e) {
      console.log(`[pangram_register] inbox read failed: ${String(e?.message || e).slice(0, 120)}`);
      continue;
    }
    const hit = inbox.find((m) => {
      const to = (Array.isArray(m.to) ? m.to : []).map((t) => typeof t === 'string' ? t : t.email || '').join(',').toLowerCase();
      const from = String(m.from || '').toLowerCase();
      const subj = String(m.subject || '').toLowerCase();
      const created = m.created_at ? Date.parse(m.created_at) : 0;
      return to.includes(email.toLowerCase()) && created >= sinceMs - 60_000 && (from.includes('pangram') || subj.includes('pangram') || subj.includes('verify'));
    });
    if (!hit) continue;
    const body = await fetchEmailBody(hit.id);
    const text = `${body.subject || ''}\n${body.text || ''}\n${body.html || ''}`;
    const code = text.match(/\b\d{5,6}\b/)?.[0] || null;
    const links = [...text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));
    const pangramLink = links.find((u) => /pangram\.com/i.test(u)) || null;
    return { id: hit.id, subject: body.subject || hit.subject || '', code, pangramLink };
  }
  return null;
}
