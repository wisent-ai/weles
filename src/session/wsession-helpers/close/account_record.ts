// What a session records about the account it made: the verification mail
// it waited for, and the account row it puts to Skarbiec with the profile
// URL the platform will show. Split out of finalize.ts.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markSignupSuccess } from '../../../utils/email/domain.js';
import { getEmailApiKey } from '../../../utils/credentials.js';
import type { WSession } from '../../wsession.js';
import { putAccount } from '../../../state/skarbiec-records.js';
import { recordingsDir } from './fingerprint_capture.js';

function profileUrl(platform: string, username: string, name?: string): string {
  const urls: Record<string, string> = {
    reddit: `https://reddit.com/u/${username}`,
    tiktok: `https://tiktok.com/@${username}`,
    github: `https://github.com/${username}`,
    discord: `https://discord.com/users/${username}`,
    linkedin: `https://linkedin.com/in/${(name ?? username).toLowerCase().replace(/\s+/g, '-')}`,
    instagram: `https://instagram.com/${username}`,
    twitter: `https://x.com/${username}`,
  };
  return urls[platform] ?? '';
}

export async function wsCheckEmail(s: WSession, email: string, sender: string): Promise<string> {
  const key = await getEmailApiKey() ?? '';
  if (!key) return 'error: no RESEND_RECEIVING_API_KEY';
  const addr = s.resolveEnv(email).toLowerCase();
  const senderHint = sender.toLowerCase();
  const earliestAcceptMs = Date.now() - 90_000;
  for (let attempt = 0; attempt < 18; attempt++) {
    const r = await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${key}` } });
    for (const em of ((await r.json()) as any).data ?? []) {
      const to = (em.to ?? []).map((t: any) => (typeof t === 'string' ? t : t.email ?? '').toLowerCase());
      if (!to.includes(addr)) continue;
      if (senderHint && !(em.from ?? '').toLowerCase().includes(senderHint)) continue;
      const emAt = em.created_at ? new Date(em.created_at).getTime() : 0;
      if (emAt < earliestAcceptMs) continue;
      const d = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
      const content = `${d.subject ?? ''}\n${d.text ?? ''}\n${d.html ?? ''}`;
      const verificationMatch = content.match(/https:\/\/api-dashboard\.search\.brave\.com\/verification[^\s"'<>\]]+/);
      if (verificationMatch) {
        const verificationURL = verificationMatch[0].replace(/&amp;/g, '&').replace(/[),.;]+$/, '');
        const target = new URL(verificationURL);
        if (target.hostname === 'api-dashboard.search.brave.com' && target.pathname === '/verification') {
          await s.page.goto(target.href, { waitUntil: 'domcontentloaded' });
          return `verification email opened on ${target.origin}${target.pathname}`;
        }
      }
      const codes = content.match(/\b\d{5,6}\b/g);
      if (codes) return codes[0];
      return `email received without numeric code: ${content.replace(/\s+/g, ' ').trim().slice(0, 2000)}`;
    }
    await new Promise(r => setTimeout(r, 10000));  // allow-raw-playwright: bounded polling/rate-limit loop
  }
  return 'no matching email received within timeout';
}

export async function wsSaveAccount(
  s: WSession,
  platform: string,
  data: { username: string; email: string; password: string; name?: string; status?: string },
): Promise<string> {
  // The account item is the durable result of this trajectory.
  const username = s.resolveEnv(data.username);
  const email = s.resolveEnv(data.email);
  const password = s.resolveEnv(data.password);
  const name = data.name ? s.resolveEnv(data.name) : undefined;
  const storageState = await s.ctx.storageState().catch(() => ({ cookies: [] as any[], origins: [] as any[] }));
  const cookies = (storageState as any).cookies ?? [];
  const metadata = {
    email,
    status: data.status ?? 'created',
    created_via: 'weles',
    cookies,
    storage_state: storageState,
    cookies_updated_at: new Date().toISOString(),
    cookies_minted_at: new Date().toISOString(),
    cookies_minted_proxy: (s as any)._proxySignature(),
    cookies_minted_persona: (s as any)._personaSignature(),
    proxy: s.proxyConfig ?? null,
    persona: (s as any).personaConfig ?? null,
    profile_url: profileUrl(platform, username, name),
  };
  try {
    const item = putAccount({
      platform,
      username,
      password,
      metadata,
      displayName: name,
    });
    writeFileSync(join(recordingsDir(s.label || undefined), 'account.json'), JSON.stringify({ item, platform, username }, null, 2));
    await markSignupSuccess(email, platform).catch(() => {});
    return `account saved: ${item}`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

